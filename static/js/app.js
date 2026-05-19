// App State
const state = {
    selectedNodeId: null,
    currentTimeRange: 1, // in hours
    nodes: {},
    activeRules: [],
    charts: {
        hardware: null,
        network: null
    },
    pollingIntervals: []
};

// CSS Color Constants matching our Styles.css tokens
const colors = {
    cyan: '#00f2fe',
    cyanGlow: 'rgba(0, 242, 254, 0.2)',
    violet: '#bd00ff',
    violetGlow: 'rgba(189, 0, 255, 0.2)',
    emerald: '#05ffc4',
    emeraldGlow: 'rgba(5, 255, 196, 0.2)',
    crimson: '#ff0055',
    crimsonGlow: 'rgba(255, 0, 85, 0.25)',
    orange: '#ff9900',
    gridColor: 'rgba(255, 255, 255, 0.05)',
    textMuted: '#64748b',
    textBright: '#e2e8f0'
};

// UI Elements mapping
const dom = {
    nodesContainer: 'nodes-list-container',
    sidebarWarnings: 'sidebar-warnings-feed',
    syncIndicator: 'sync-indicator',
    headerNodeName: 'header-node-name',
    headerNodeIp: 'header-node-ip',
    headerNodeMac: 'header-node-mac',
    headerNodeOs: 'header-node-os',
    headerNodeUptime: 'header-node-uptime',
    headerStatusDot: 'header-status-dot',
    cpuValue: 'cpu-value',
    cpuGauge: 'cpu-gauge',
    cpuCard: 'cpu-card',
    ramValue: 'ram-value',
    ramGauge: 'ram-gauge',
    ramCard: 'ram-card',
    pingValue: 'ping-value',
    lossValue: 'loss-value',
    pingCard: 'ping-card',
    bandwidthValue: 'bandwidth-value',
    bandwidthStability: 'bandwidth-stability',
    bandwidthCard: 'bandwidth-card',
    sqlP95Ping: 'sql-p95-ping',
    sqlRollingPing: 'sql-rolling-ping',
    sqlRollingCpu: 'sql-rolling-cpu',
    sqlUptime: 'sql-uptime',
    thresholdForm: 'threshold-form',
    thresholdMetric: 'threshold-metric',
    thresholdOp: 'threshold-op',
    thresholdRange: 'threshold-value-range',
    thresholdNum: 'threshold-value-num',
    activeRulesContainer: 'active-rules-container',
    timeRangeContainer: 'time-range-container',
    incidentsTableBody: 'incidents-table-body'
};

const getElement = (id) => document.getElementById(id);

// Format seconds into a pretty, compact uptime string
function formatUptime(seconds) {
    if (!seconds || isNaN(seconds)) return '0s';
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    let parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);

    return parts.join(' ');
}

// --------------------------------------------------------------------------
// API CALLS
// --------------------------------------------------------------------------

// Fetch all nodes, update sidebar listing, detect dead nodes
async function fetchNodes() {
    try {
        const response = await fetch('/api/nodes');
        const nodesData = await response.json();

        // Show active sync pulsing
        const syncBadge = getElement(dom.syncIndicator);
        if (syncBadge) {
            syncBadge.innerText = 'SYNCED';
            syncBadge.style.animation = 'none';
            setTimeout(() => { syncBadge.style.animation = ''; }, 100);
        }

        // Map list to internal object state
        const oldSelected = state.selectedNodeId;
        state.nodes = {};

        nodesData.forEach(node => {
            state.nodes[node.id] = node;
        });

        // Set default selected node on first load
        if (!state.selectedNodeId && nodesData.length > 0) {
            state.selectedNodeId = nodesData[0].id;
        }

        renderNodesList();
        updateSelectedNodeUI();
        updateBreachWarnings();
    } catch (error) {
        console.error("Error fetching nodes:", error);
    }
}

// Fetch active rules configuration
async function fetchAlertRules() {
    try {
        const response = await fetch('/api/alerts');
        state.activeRules = await response.json();
        renderActiveRulesList();
    } catch (error) {
        console.error("Error fetching alert rules:", error);
    }
}

// Fetch and render incident log history
async function fetchIncidents() {
    try {
        const response = await fetch('/api/incidents');
        const incidents = await response.json();
        renderIncidentsTable(incidents);
    } catch (error) {
        console.error("Error fetching incident history:", error);
    }
}

// Fetch advanced SQL statistics
async function fetchAnalytics() {
    if (!state.selectedNodeId) return;
    try {
        const response = await fetch(`/api/nodes/${state.selectedNodeId}/analytics`);
        const analytics = await response.json();

        getElement(dom.sqlP95Ping).innerText = analytics.p95_ping_7d !== null ? analytics.p95_ping_7d : '-';
        getElement(dom.sqlRollingPing).innerText = analytics.rolling_avg_ping !== null ? analytics.rolling_avg_ping : '-';
        getElement(dom.sqlRollingCpu).innerText = analytics.rolling_avg_cpu !== null ? analytics.rolling_avg_cpu : '-';
        getElement(dom.sqlUptime).innerText = analytics.uptime_24h_pct !== null ? analytics.uptime_24h_pct : '-';
    } catch (error) {
        console.error("Error fetching analytics:", error);
    }
}

// Fetch historical time series and update Chart.js instances
async function fetchHistoryAndCharts() {
    if (!state.selectedNodeId) return;
    try {
        const response = await fetch(`/api/nodes/${state.selectedNodeId}/history?range=${state.currentTimeRange}`);
        const history = await response.json();
        updateCharts(history);
    } catch (error) {
        console.error("Error fetching historical charts:", error);
    }
}

// --------------------------------------------------------------------------
// UI RENDERERS
// --------------------------------------------------------------------------

// Render Monitored Systems in Left Sidebar
function renderNodesList() {
    const container = getElement(dom.nodesContainer);
    if (!container) return;

    let html = '';
    const nodeList = Object.values(state.nodes);

    if (nodeList.length === 0) {
        container.innerHTML = '<div class="warning-item placeholder">No systems active. Start daemon/simulator.</div>';
        return;
    }

    nodeList.forEach(node => {
        const isActive = node.id === state.selectedNodeId ? 'active' : '';
        const isOnline = node.status === 'ONLINE';
        const statusPulse = isOnline ? 'online' : 'offline';
        const hasAlerts = node.active_incidents_count > 0;

        // Truncate OS
        const shortOS = node.os_name ? node.os_name.split(' ')[0] : 'Unknown';

        html += `
            <div class="node-item ${isActive}" onclick="selectNode('${node.id}')">
                <div class="node-item-header">
                    <div class="node-title-wrap">
                        <div class="node-pulse ${statusPulse}"></div>
                        <h4>${node.hostname}</h4>
                    </div>
                    ${hasAlerts ? `<span class="incident-pill">${node.active_incidents_count} ALERT</span>` : ''}
                </div>
                <div class="node-item-body">
                    <span>${node.ip_address || '-'}</span>
                    <span class="metrics">${isOnline ? `CPU ${Math.round(node.cpu_utilization)}% | ${Math.round(node.ping_ms)}ms` : 'OFFLINE'}</span>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

// Scan nodes for breaches and display alert ticker summaries in sidebar footer
function updateBreachWarnings() {
    const feed = getElement(dom.sidebarWarnings);
    if (!feed) return;

    let html = '';
    let breachCount = 0;

    Object.values(state.nodes).forEach(node => {
        if (node.status === 'ONLINE') {
            // Basic soft limits evaluated locally in UI just to populate real-time warning dashboard
            if (node.cpu_utilization > 80.0) {
                breachCount++;
                html += `<div class="warning-item severe"><strong>${node.hostname}</strong>: High CPU load detected (${Math.round(node.cpu_utilization)}%)</div>`;
            }
            if (node.ping_ms > 80.0) {
                breachCount++;
                html += `<div class="warning-item"><strong>${node.hostname}</strong>: Latency spike recorded (${Math.round(node.ping_ms)}ms)</div>`;
            }
            if (node.packet_loss > 1.0) {
                breachCount++;
                html += `<div class="warning-item severe"><strong>${node.hostname}</strong>: Network packet loss registered (${node.packet_loss}%)</div>`;
            }
        }
    });

    if (breachCount === 0) {
        feed.innerHTML = '<div class="warning-item placeholder">No active breaches reported. System fully operational.</div>';
    } else {
        feed.innerHTML = html;
    }
}

// Update primary main layout fields for selected node
function updateSelectedNodeUI() {
    const node = state.nodes[state.selectedNodeId];
    if (!node) return;

    // Header updates
    getElement(dom.headerNodeName).innerText = node.hostname;
    getElement(dom.headerNodeIp).innerText = node.ip_address || '-';
    getElement(dom.headerNodeMac).innerText = node.mac_address || '-';
    getElement(dom.headerNodeOs).innerText = node.os_name || '-';

    const uptimeStr = node.status === 'ONLINE' ? formatUptime(node.uptime_seconds) : 'OFFLINE';
    getElement(dom.headerNodeUptime).innerText = uptimeStr;

    const dot = getElement(dom.headerStatusDot);
    dot.className = 'node-status-indicator';
    dot.classList.add(node.status === 'ONLINE' ? 'online' : 'offline');

    // Online specific widgets
    const isOnline = node.status === 'ONLINE';

    // CPU Card
    const cpuVal = isOnline ? node.cpu_utilization : 0;
    getElement(dom.cpuValue).innerText = Math.round(cpuVal);
    getElement(dom.cpuGauge).setAttribute('stroke-dasharray', `${cpuVal}, 100`);
    getElement(dom.cpuCard).className = `metric-card shadow-glow ${cpuVal > 80 ? 'breached' : ''}`;

    // RAM Card
    const ramVal = isOnline ? node.ram_utilization : 0;
    getElement(dom.ramValue).innerText = Math.round(ramVal);
    getElement(dom.ramGauge).setAttribute('stroke-dasharray', `${ramVal}, 100`);
    getElement(dom.ramCard).className = `metric-card shadow-glow ${ramVal > 80 ? 'breached' : ''}`;

    // Ping Card
    const pingVal = isOnline ? node.ping_ms : 0.0;
    const lossVal = isOnline ? node.packet_loss : 0.0;
    getElement(dom.pingValue).innerText = pingVal.toFixed(1);
    getElement(dom.lossValue).innerText = `${lossVal.toFixed(1)}%`;
    getElement(dom.pingCard).className = `metric-card shadow-glow ${pingVal > 80.0 || lossVal > 1.0 ? 'breached' : ''}`;

    // Bandwidth Card
    const bandVal = isOnline ? node.bandwidth_mbps : 0.0;
    getElement(dom.bandwidthValue).innerText = bandVal.toFixed(1);

    let stabilityText = 'STABLE';
    if (lossVal > 2.0) stabilityText = 'SEVERE DROP';
    else if (lossVal > 0.5) stabilityText = 'UNSTABLE';
    else if (bandVal < 20.0 && isOnline) stabilityText = 'SLOW';

    getElement(dom.bandwidthStability).innerText = isOnline ? stabilityText : 'OFFLINE';
    getElement(dom.bandwidthCard).className = `metric-card shadow-glow ${stabilityText === 'SEVERE DROP' ? 'breached' : ''}`;
}

// Render active thresholds configuration rules list
function renderActiveRulesList() {
    const container = getElement(dom.activeRulesContainer);
    if (!container) return;

    // Filter rules mapped to this specific node
    const rules = state.activeRules.filter(r => r.node_id === state.selectedNodeId);

    if (rules.length === 0) {
        container.innerHTML = '<span class="rules-placeholder">No custom limits configured for this node.</span>';
        return;
    }

    let html = '';
    rules.forEach(rule => {
        let displayMetric = rule.metric_type.toUpperCase();
        let displayUnit = '%';
        if (rule.metric_type === 'ping') {
            displayMetric = 'LATENCY';
            displayUnit = 'ms';
        } else if (rule.metric_type === 'bandwidth') {
            displayMetric = 'MIN BAND';
            displayUnit = 'Mbps';
        } else if (rule.metric_type === 'packet_loss') {
            displayMetric = 'LOSS';
        }

        html += `
            <div class="rule-pill-item">
                <div class="rule-pill-left">
                    <span class="rule-metric-badge">${displayMetric}</span>
                    <span class="rule-formula">${rule.operator} ${rule.threshold_value}${displayUnit}</span>
                </div>
                <button type="button" class="btn-delete" onclick="deleteAlertRule(${rule.id})">DELETE</button>
            </div>
        `;
    });

    container.innerHTML = html;
}

// Render incident tables
function renderIncidentsTable(incidents) {
    const tbody = getElement(dom.incidentsTableBody);
    if (!tbody) return;

    if (incidents.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="table-placeholder">No threshold breaches logged. All systems nominal.</td>
            </tr>
        `;
        return;
    }

    let html = '';
    incidents.forEach(inc => {
        const isActive = inc.status === 'ACTIVE';
        const statusBadge = isActive
            ? `<span class="badge-status active">ACTIVE BREACH</span>`
            : `<span class="badge-status resolved">RESOLVED</span>`;

        let metricName = inc.metric_type.toUpperCase();
        let unit = '%';
        if (inc.metric_type === 'ping') {
            metricName = 'LATENCY';
            unit = 'ms';
        } else if (inc.metric_type === 'bandwidth') {
            metricName = 'BANDWIDTH';
            unit = 'Mbps';
        }

        const triggerClass = inc.triggered_value > inc.threshold_value ? 'high' : 'low';

        // Format ISO UTC timestamps to browser local string
        const formatTime = (ts) => {
            if (!ts) return '-';
            // Parse sqlite datetime string
            const t = new Date(ts.replace(' ', 'T') + 'Z');
            return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        };

        html += `
            <tr>
                <td class="mono font-outfit"><strong>${inc.hostname}</strong></td>
                <td><span class="rule-metric-badge">${metricName}</span></td>
                <td><span class="trigger-value-text ${triggerClass}">${inc.triggered_value}${unit}</span></td>
                <td class="mono">${inc.operator} ${inc.threshold_value}${unit}</td>
                <td class="mono">${formatTime(inc.start_time)}</td>
                <td class="mono">${isActive ? '-' : formatTime(inc.end_time)}</td>
                <td>${statusBadge}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

// --------------------------------------------------------------------------
// CHART.JS ENGINES
// --------------------------------------------------------------------------

// Rebuild or update the charts datasets
function updateCharts(history) {
    const labels = history.map(h => {
        // Parse database time
        const t = new Date(h.timestamp.replace(' ', 'T') + 'Z');
        return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });

    const cpuData = history.map(h => h.cpu_utilization);
    const ramData = history.map(h => h.ram_utilization);
    const pingData = history.map(h => h.ping_ms);
    const lossData = history.map(h => h.packet_loss);

    // Grid details for custom dark style
    const gridStyle = {
        color: colors.gridColor,
        borderColor: 'rgba(255, 255, 255, 0.08)'
    };

    const labelStyle = {
        color: colors.textMuted,
        font: {
            family: 'Inter',
            size: 10
        }
    };

    // A. Create/Update Hardware Performance Chart
    if (!state.charts.hardware) {
        const ctx = document.getElementById('hardware-chart').getContext('2d');

        // Gradient configurations
        const gradCpu = ctx.createLinearGradient(0, 0, 0, 240);
        gradCpu.addColorStop(0, 'rgba(0, 242, 254, 0.15)');
        gradCpu.addColorStop(1, 'rgba(0, 242, 254, 0)');

        const gradRam = ctx.createLinearGradient(0, 0, 0, 240);
        gradRam.addColorStop(0, 'rgba(189, 0, 255, 0.15)');
        gradRam.addColorStop(1, 'rgba(189, 0, 255, 0)');

        state.charts.hardware = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'CPU Utilization (%)',
                        data: cpuData,
                        borderColor: colors.cyan,
                        backgroundColor: gradCpu,
                        borderWidth: 2,
                        fill: true,
                        tension: 0.3,
                        pointRadius: labels.length > 30 ? 0 : 2,
                        pointBackgroundColor: colors.cyan,
                        shadowColor: colors.cyanGlow,
                        shadowBlur: 8
                    },
                    {
                        label: 'RAM Utilization (%)',
                        data: ramData,
                        borderColor: colors.violet,
                        backgroundColor: gradRam,
                        borderWidth: 2,
                        fill: true,
                        tension: 0.3,
                        pointRadius: labels.length > 30 ? 0 : 2,
                        pointBackgroundColor: colors.violet
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: colors.textBright, font: { family: 'Outfit', size: 11 } }
                    }
                },
                scales: {
                    x: { grid: gridStyle, ticks: labelStyle },
                    y: { grid: gridStyle, ticks: labelStyle, min: 0, max: 100 }
                }
            }
        });
    } else {
        // Simple fast update
        state.charts.hardware.data.labels = labels;
        state.charts.hardware.data.datasets[0].data = cpuData;
        state.charts.hardware.data.datasets[1].data = ramData;
        state.charts.hardware.update('none'); // Update without full recalculation redraws
    }

    // B. Create/Update Network Stability Chart
    if (!state.charts.network) {
        const ctx = document.getElementById('network-chart').getContext('2d');

        const gradPing = ctx.createLinearGradient(0, 0, 0, 240);
        gradPing.addColorStop(0, 'rgba(5, 255, 196, 0.15)');
        gradPing.addColorStop(1, 'rgba(5, 255, 196, 0)');

        state.charts.network = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Latency (ms)',
                        data: pingData,
                        borderColor: colors.emerald,
                        backgroundColor: gradPing,
                        borderWidth: 2,
                        fill: true,
                        tension: 0.3,
                        yAxisID: 'y',
                        pointRadius: labels.length > 30 ? 0 : 2,
                        pointBackgroundColor: colors.emerald
                    },
                    {
                        label: 'Packet Loss (%)',
                        data: lossData,
                        borderColor: colors.crimson,
                        backgroundColor: 'rgba(255, 0, 85, 0.2)',
                        borderWidth: 1.5,
                        fill: true,
                        yAxisID: 'y1',
                        type: 'bar',
                        barThickness: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: colors.textBright, font: { family: 'Outfit', size: 11 } }
                    }
                },
                scales: {
                    x: { grid: gridStyle, ticks: labelStyle },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        grid: gridStyle,
                        ticks: labelStyle,
                        title: { display: true, text: 'Latency (ms)', color: colors.textMuted }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        min: 0,
                        max: 10,
                        grid: { drawOnChartArea: false }, // avoid double grid overlap
                        ticks: labelStyle,
                        title: { display: true, text: 'Loss (%)', color: colors.textMuted }
                    }
                }
            }
        });
    } else {
        state.charts.network.data.labels = labels;
        state.charts.network.data.datasets[0].data = pingData;
        state.charts.network.data.datasets[1].data = lossData;
        state.charts.network.update('none');
    }
}

// --------------------------------------------------------------------------
// EVENT ACTIONS
// --------------------------------------------------------------------------

// Node selection
function selectNode(id) {
    if (state.selectedNodeId === id) return;
    state.selectedNodeId = id;

    // Perform rapid UI transitions
    renderNodesList();
    updateSelectedNodeUI();

    // Clear and redraw rules instantly
    renderActiveRulesList();

    // Trigger immediate reload of background datasets
    fetchHistoryAndCharts();
    fetchAnalytics();
    fetchAlertRules();
}

// Time Range Pickers
function setupTimeRangePicker() {
    const container = getElement(dom.timeRangeContainer);
    if (!container) return;

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.range-btn');
        if (!btn) return;

        // Update selection class UI
        container.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        state.currentTimeRange = parseInt(btn.dataset.range);

        // Instantly reload history charts with appropriate metrics range
        fetchHistoryAndCharts();
    });
}

// Slider sync
function setupSliderSync() {
    const range = getElement(dom.thresholdRange);
    const num = getElement(dom.thresholdNum);
    const metricSelect = getElement(dom.thresholdMetric);

    if (!range || !num) return;

    // Dynamic sliders caps depending on metric selector type
    metricSelect.addEventListener('change', () => {
        const val = metricSelect.value;
        if (val === 'ping') {
            range.max = 300; range.value = 80; num.value = 80;
        } else if (val === 'packet_loss') {
            range.max = 20; range.value = 2; num.value = 2;
        } else if (val === 'bandwidth') {
            range.max = 500; range.value = 20; num.value = 20;
        } else {
            range.max = 100; range.value = 80; num.value = 80;
        }
    });

    range.addEventListener('input', () => { num.value = range.value; });
    num.addEventListener('input', () => { range.value = num.value; });
}

// Rule Creation form Submission
function setupFormHandler() {
    const form = getElement(dom.thresholdForm);
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!state.selectedNodeId) {
            alert("No target node selected!");
            return;
        }

        const payload = {
            node_id: state.selectedNodeId,
            metric_type: getElement(dom.thresholdMetric).value,
            operator: getElement(dom.thresholdOp).value,
            threshold_value: parseFloat(getElement(dom.thresholdNum).value)
        };

        const saveBtn = getElement('save-threshold-btn');
        saveBtn.innerText = 'SAVING RULE...';
        saveBtn.disabled = true;

        try {
            const response = await fetch('/api/alerts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();

            if (data.status === 'success') {
                // Success feedback animations
                saveBtn.innerText = 'DATABASE SAVED!';
                saveBtn.style.background = 'linear-gradient(135deg, #05ffc4, #00b4d8)';

                await fetchAlertRules();
                setTimeout(() => {
                    saveBtn.innerText = 'SAVE DATABASE RULE';
                    saveBtn.style.background = '';
                    saveBtn.disabled = false;
                }, 1500);
            } else {
                alert(`Error: ${data.message}`);
                saveBtn.innerText = 'SAVE DATABASE RULE';
                saveBtn.disabled = false;
            }
        } catch (error) {
            console.error("Error creating alert rule:", error);
            saveBtn.innerText = 'SAVE DATABASE RULE';
            saveBtn.disabled = false;
        }
    });
}

// Delete alert rule from DB
async function deleteAlertRule(ruleId) {
    if (!confirm("Delete this database threshold rule?")) return;
    try {
        const response = await fetch('/api/alerts/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ruleId })
        });
        const data = await response.json();
        if (data.status === 'success') {
            await fetchAlertRules();
        } else {
            alert(`Error deleting rule: ${data.message}`);
        }
    } catch (error) {
        console.error("Error deleting alert rule:", error);
    }
}

// --------------------------------------------------------------------------
// BOOTSTRAPPING INITIALIZATION
// --------------------------------------------------------------------------

async function init() {
    console.log("=== Initializing SysBeat Telemetry Client Dashboard ===");

    // Form and picker setups
    setupTimeRangePicker();
    setupSliderSync();
    setupFormHandler();

    // 1. Initial fast data fetch
    await fetchNodes();
    await fetchAlertRules();
    await fetchIncidents();
    await fetchAnalytics();
    await fetchHistoryAndCharts();

    // 2. Clear previous intervals if any
    state.pollingIntervals.forEach(clearInterval);
    state.pollingIntervals = [];

    // 3. Register fast polling loops for real-time responsiveness
    // High frequency (2s) for live stats/nodes status/incidents list
    state.pollingIntervals.push(setInterval(fetchNodes, 2000));
    state.pollingIntervals.push(setInterval(fetchIncidents, 2000));

    // Moderate frequency (5s) for heavy historical aggregation charts and analytics summaries
    state.pollingIntervals.push(setInterval(fetchHistoryAndCharts, 5000));
    state.pollingIntervals.push(setInterval(fetchAnalytics, 5000));
}

// Boot
window.addEventListener('DOMContentLoaded', init);
