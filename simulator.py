import time
import random
import threading
import requests

SERVER_URL = "http://localhost:5000/api/daemon/telemetry"
INTERVAL_SECONDS = 3  # High frequency to show concurrency and live charts

# Definition of simulated nodes and their baseline behaviors
NODES_CONFIG = {
    "vpn-gateway-hq": {
        "hostname": "vpn-gateway-hq",
        "ip_address": "10.8.0.1",
        "mac_address": "00:8d:fa:11:22:01",
        "os_name": "Linux Ubuntu 22.04 LTS",
        # Behavioral stats
        "cpu_base": 12.0, "cpu_var": 5.0,
        "ram_base": 34.0, "ram_var": 2.0,
        "ping_base": 5.0,  "ping_var": 1.5,
        "packet_loss_base": 0.0, "packet_loss_spike_prob": 0.01,
        "bandwidth_base": 120.0, "bandwidth_var": 10.0,
        "uptime_start": 1827400
    },
    "remote-streaming-rig": {
        "hostname": "remote-streaming-rig",
        "ip_address": "10.8.0.15",
        "mac_address": "00:8d:fa:11:22:02",
        "os_name": "Windows 11 Pro (23H2)",
        "cpu_base": 45.0, "cpu_var": 15.0,
        "ram_base": 58.0, "ram_var": 4.0,
        "ping_base": 18.0, "ping_var": 4.0,
        "packet_loss_base": 0.0, "packet_loss_spike_prob": 0.08, # Spikes sometimes
        "bandwidth_base": 95.0, "bandwidth_var": 15.0,
        "uptime_start": 345000
    },
    "kubernetes-node-03": {
        "hostname": "kubernetes-node-03",
        "ip_address": "192.168.10.103",
        "mac_address": "00:8d:fa:11:22:03",
        "os_name": "RedHat Enterprise Linux 9.3",
        "cpu_base": 72.0, "cpu_var": 18.0, # High CPU baseline (frequent alerts)
        "ram_base": 78.0, "ram_var": 5.0,
        "ping_base": 3.0,  "ping_var": 0.8,
        "packet_loss_base": 0.0, "packet_loss_spike_prob": 0.005,
        "bandwidth_base": 450.0, "bandwidth_var": 40.0,
        "uptime_start": 1290300
    },
    "office-workstation": {
        "hostname": "office-workstation",
        "ip_address": "192.168.1.42",
        "mac_address": "00:8d:fa:11:22:04",
        "os_name": "Windows 11 Home",
        "cpu_base": 18.0, "cpu_var": 12.0,
        "ram_base": 48.0, "ram_var": 10.0,
        "ping_base": 42.0, "ping_var": 25.0, # Highly variable latency (spiky)
        "packet_loss_base": 0.1, "packet_loss_spike_prob": 0.05,
        "bandwidth_base": 35.0, "bandwidth_var": 8.0,
        "uptime_start": 48300
    }
}

class SimulatedNode(threading.Thread):
    def __init__(self, node_id, config):
        super().__init__()
        self.node_id = node_id
        self.config = config
        self.running = True
        self.daemon = True
        self.uptime = config["uptime_start"]
        self.lock = threading.Lock()

    def run(self):
        print(f"[Simulator] Initializing virtual client: {self.config['hostname']} ({self.node_id})")
        
        while self.running:
            try:
                # 1. Synthesize realistic telemetry based on profiles
                cpu = max(0.0, min(100.0, self.config["cpu_base"] + random.uniform(-self.config["cpu_var"], self.config["cpu_var"])))
                ram = max(0.0, min(100.0, self.config["ram_base"] + random.uniform(-self.config["ram_var"], self.config["ram_var"])))
                
                # Check for random latency/packet loss spikes
                is_spiking = random.random() < self.config["packet_loss_spike_prob"]
                if is_spiking:
                    ping = self.config["ping_base"] * random.uniform(3.0, 6.0)
                    packet_loss = random.uniform(5.0, 15.0)
                    bandwidth = self.config["bandwidth_base"] * 0.15 # Drop speed
                else:
                    ping = max(1.0, self.config["ping_base"] + random.uniform(-self.config["ping_var"], self.config["ping_var"]))
                    packet_loss = self.config["packet_loss_base"] + (random.uniform(0.0, 0.4) if random.random() < 0.2 else 0.0)
                    bandwidth = max(1.0, self.config["bandwidth_base"] + random.uniform(-self.config["bandwidth_var"], self.config["bandwidth_var"]))
                
                # Occasional massive CPU spikes for Kubernetes node to verify alerts
                if self.config["hostname"] == "kubernetes-node-03" and random.random() < 0.15:
                    cpu = random.uniform(92.0, 99.5)
                    
                # Increment uptime
                self.uptime += INTERVAL_SECONDS
                
                payload = {
                    "id": self.node_id,
                    "hostname": self.config["hostname"],
                    "ip_address": self.config["ip_address"],
                    "mac_address": self.config["mac_address"],
                    "os_name": self.config["os_name"],
                    "ping_ms": round(ping, 2),
                    "cpu_utilization": round(cpu, 2),
                    "ram_utilization": round(ram, 2),
                    "packet_loss": round(packet_loss, 2),
                    "bandwidth_mbps": round(bandwidth, 2),
                    "uptime_seconds": self.uptime
                }
                
                # 2. Upload metrics via API
                response = requests.post(SERVER_URL, json=payload, timeout=3)
                if response.status_code != 200:
                    print(f"[{self.config['hostname']}] Upload error: {response.text}")
                    
            except requests.exceptions.RequestException:
                # Silently catch network failures when server is starting/restarting
                pass
            except Exception as e:
                print(f"[{self.config['hostname']}] Error: {str(e)}")
                
            time.sleep(INTERVAL_SECONDS)

    def terminate(self):
        self.running = False

def main():
    print("=== Multi-Node Telemetry Network Simulator ===")
    print(f"POSTing concurrently to: {SERVER_URL}")
    print(f"Spawning {len(NODES_CONFIG)} simulated node environments...")
    print("Press Ctrl+C to terminate the simulation.")
    print("-" * 50)
    
    threads = []
    for node_id, config in NODES_CONFIG.items():
        t = SimulatedNode(node_id, config)
        threads.append(t)
        t.start()
        
    try:
        while True:
            # Let the simulator print out status summaries periodically
            time.sleep(10)
            print(f"[{time.strftime('%H:%M:%S')}] Active Simulation Status: 4 environments logging metrics...")
    except KeyboardInterrupt:
        print("\nShutting down virtual node environment simulator...")
        for t in threads:
            t.terminate()
        for t in threads:
            t.join()
        print("Simulator successfully halted.")

if __name__ == "__main__":
    main()
