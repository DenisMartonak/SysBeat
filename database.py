import sqlite3
import os

DB_NAME = "network_telemetry.db"

def get_db_connection(db_path=DB_NAME):
    """
    Creates and returns a connection to the SQLite database.
    Configures Write-Ahead Logging (WAL) and foreign keys for safe, robust concurrency.
    """
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    
    # Configure database settings for high-performance concurrent environments
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    
    return conn

def init_db(db_path=DB_NAME):
    """
    Initializes the database schema including tables, composite indexes, 
    views for rolling averages, and triggers for real-time alerting and aggregations.
    """
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    
    # 1. Create Nodes Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        hostname TEXT NOT NULL,
        ip_address TEXT,
        mac_address TEXT UNIQUE,
        os_name TEXT,
        status TEXT DEFAULT 'ONLINE',
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)
    
    # 2. Create Telemetry Logs Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS telemetry_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        ping_ms REAL,
        cpu_utilization REAL,
        ram_utilization REAL,
        packet_loss REAL,
        bandwidth_mbps REAL,
        uptime_seconds INTEGER
    );
    """)
    
    # Create composite index on telemetry table for rapid time-range operations
    cursor.execute("""
    CREATE INDEX IF NOT EXISTS idx_telemetry_node_timestamp 
    ON telemetry_logs (node_id, timestamp);
    """)
    
    # 3. Create Alerts Configuration Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS alerts_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
        metric_type TEXT NOT NULL,       -- 'cpu', 'ram', 'ping', 'packet_loss', 'bandwidth'
        operator TEXT NOT NULL,          -- '>', '<'
        threshold_value REAL NOT NULL,
        is_active INTEGER DEFAULT 1,
        UNIQUE(node_id, metric_type)     -- Only one warning threshold rule per metric type per node
    );
    """)
    
    # 4. Create Incident History Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS incident_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
        alert_id INTEGER REFERENCES alerts_config(id) ON DELETE CASCADE,
        metric_type TEXT NOT NULL,
        triggered_value REAL NOT NULL,
        threshold_value REAL NOT NULL,
        start_time DATETIME NOT NULL,
        end_time DATETIME,              -- NULL if active
        status TEXT DEFAULT 'ACTIVE'    -- 'ACTIVE', 'RESOLVED'
    );
    """)
    
    # 5. Create Hourly Telemetry Summary Table (for aggregate storage)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS hourly_telemetry_summary (
        node_id TEXT,
        hour TEXT, -- Format: YYYY-MM-DD HH:00:00
        avg_ping REAL,
        avg_cpu REAL,
        avg_ram REAL,
        avg_packet_loss REAL,
        avg_bandwidth REAL,
        log_count INTEGER,
        PRIMARY KEY (node_id, hour)
    );
    """)

    # 6. Create Trigger: Checks telemetry logs, creates incidents, and auto-resolves them
    cursor.execute("""
    CREATE TRIGGER IF NOT EXISTS trg_check_alerts
    AFTER INSERT ON telemetry_logs
    BEGIN
        -- Insert new ACTIVE incident if a threshold is breached and no active incident exists for that alert configuration
        INSERT INTO incident_history (node_id, alert_id, metric_type, triggered_value, threshold_value, start_time, status)
        SELECT 
            NEW.node_id,
            ac.id,
            ac.metric_type,
            CASE 
                WHEN ac.metric_type = 'cpu' THEN NEW.cpu_utilization
                WHEN ac.metric_type = 'ram' THEN NEW.ram_utilization
                WHEN ac.metric_type = 'ping' THEN NEW.ping_ms
                WHEN ac.metric_type = 'packet_loss' THEN NEW.packet_loss
                ELSE NEW.bandwidth_mbps
            END,
            ac.threshold_value,
            datetime('now', 'localtime'),
            'ACTIVE'
        FROM alerts_config ac
        WHERE ac.node_id = NEW.node_id
          AND ac.is_active = 1
          AND (
              (ac.metric_type = 'cpu' AND ac.operator = '>' AND NEW.cpu_utilization > ac.threshold_value) OR
              (ac.metric_type = 'ram' AND ac.operator = '>' AND NEW.ram_utilization > ac.threshold_value) OR
              (ac.metric_type = 'ping' AND ac.operator = '>' AND NEW.ping_ms > ac.threshold_value) OR
              (ac.metric_type = 'packet_loss' AND ac.operator = '>' AND NEW.packet_loss > ac.threshold_value) OR
              (ac.metric_type = 'bandwidth' AND ac.operator = '<' AND NEW.bandwidth_mbps < ac.threshold_value)
          )
          AND NOT EXISTS (
              SELECT 1 FROM incident_history ih 
              WHERE ih.alert_id = ac.id AND ih.status = 'ACTIVE'
          );

        -- Auto-resolve incidents if metric returns to normal parameters
        UPDATE incident_history
        SET status = 'RESOLVED',
            end_time = datetime('now', 'localtime')
        WHERE status = 'ACTIVE'
          AND alert_id IN (
              SELECT ac.id 
              FROM alerts_config ac
              WHERE ac.node_id = incident_history.node_id
                AND ac.is_active = 1
                AND NOT (
                    (ac.metric_type = 'cpu' AND ac.operator = '>' AND NEW.cpu_utilization > ac.threshold_value) OR
                    (ac.metric_type = 'ram' AND ac.operator = '>' AND NEW.ram_utilization > ac.threshold_value) OR
                    (ac.metric_type = 'ping' AND ac.operator = '>' AND NEW.ping_ms > ac.threshold_value) OR
                    (ac.metric_type = 'packet_loss' AND ac.operator = '>' AND NEW.packet_loss > ac.threshold_value) OR
                    (ac.metric_type = 'bandwidth' AND ac.operator = '<' AND NEW.bandwidth_mbps < ac.threshold_value)
                )
          );
    END;
    """)

    # 7. Create Trigger: Performs real-time O(1) hourly metric aggregation
    cursor.execute("""
    CREATE TRIGGER IF NOT EXISTS trg_aggregate_hourly
    AFTER INSERT ON telemetry_logs
    BEGIN
        INSERT INTO hourly_telemetry_summary (node_id, hour, avg_ping, avg_cpu, avg_ram, avg_packet_loss, avg_bandwidth, log_count)
        VALUES (
            NEW.node_id,
            strftime('%Y-%m-%d %H:00:00', datetime('now', 'localtime')),
            NEW.ping_ms,
            NEW.cpu_utilization,
            NEW.ram_utilization,
            NEW.packet_loss,
            NEW.bandwidth_mbps,
            1
        )
        ON CONFLICT(node_id, hour) DO UPDATE SET
            avg_ping = (hourly_telemetry_summary.avg_ping * hourly_telemetry_summary.log_count + excluded.avg_ping) / (hourly_telemetry_summary.log_count + 1),
            avg_cpu = (hourly_telemetry_summary.avg_cpu * hourly_telemetry_summary.log_count + excluded.avg_cpu) / (hourly_telemetry_summary.log_count + 1),
            avg_ram = (hourly_telemetry_summary.avg_ram * hourly_telemetry_summary.log_count + excluded.avg_ram) / (hourly_telemetry_summary.log_count + 1),
            avg_packet_loss = (hourly_telemetry_summary.avg_packet_loss * hourly_telemetry_summary.log_count + excluded.avg_packet_loss) / (hourly_telemetry_summary.log_count + 1),
            avg_bandwidth = (hourly_telemetry_summary.avg_bandwidth * hourly_telemetry_summary.log_count + excluded.avg_bandwidth) / (hourly_telemetry_summary.log_count + 1),
            log_count = hourly_telemetry_summary.log_count + 1;
    END;
    """)

    # 8. Create View: Calculated rolling analytics over last 10 samples per node
    cursor.execute("""
    CREATE VIEW IF NOT EXISTS view_rolling_analytics AS
    SELECT 
        node_id,
        timestamp,
        ping_ms,
        AVG(ping_ms) OVER (
            PARTITION BY node_id 
            ORDER BY timestamp 
            ROWS BETWEEN 10 PRECEDING AND CURRENT ROW
        ) AS rolling_avg_ping,
        cpu_utilization,
        AVG(cpu_utilization) OVER (
            PARTITION BY node_id 
            ORDER BY timestamp 
            ROWS BETWEEN 10 PRECEDING AND CURRENT ROW
        ) AS rolling_avg_cpu,
        packet_loss,
        AVG(packet_loss) OVER (
            PARTITION BY node_id 
            ORDER BY timestamp 
            ROWS BETWEEN 10 PRECEDING AND CURRENT ROW
        ) AS rolling_avg_packet_loss
    FROM telemetry_logs;
    """)
    
    conn.commit()
    conn.close()
    print("Database successfully initialized!")

if __name__ == "__main__":
    init_db()
