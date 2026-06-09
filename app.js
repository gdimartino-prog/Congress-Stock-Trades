// --- CONSTANTS & DATA PATHS ---
const DATA_URL = "https://raw.githubusercontent.com/kadoa-org/congress-trading-monitor/main/public/data/trades.json";
const CACHE_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours cache
const DB_NAME = "CongressStockTradesDB";
const STORE_NAME = "tradesStore";

// --- STATE MANAGEMENT ---
let allTrades = [];
let filteredTrades = [];
let currentPage = 1;
const itemsPerPage = 25;
let currentSortField = "transaction_date";
let currentSortDirection = "desc";

// Active filter states
let filterSearch = "";
let filterChamber = "all";
let filterType = "all";
let filterMinSize = 0;
let filterMaxSize = Infinity;

// Chart instances
let volumeChart = null;
let stocksChart = null;
let politiciansChart = null;

// --- INDEXEDDB CACHE HELPER ---
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function getCachedTrades() {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get("trades_data");
            req.onsuccess = () => {
                if (req.result && Date.now() - req.result.timestamp < CACHE_DURATION_MS) {
                    resolve(req.result);
                } else {
                    resolve(null); // Expired or missing
                }
            };
            req.onerror = () => resolve(null);
        });
    } catch (err) {
        console.error("IndexedDB error:", err);
        return null;
    }
}

async function getCachedTradesFallback() {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get("trades_data");
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (err) {
        return null;
    }
}

async function saveTradesToCache(data) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const cacheObj = {
                data: data,
                timestamp: Date.now()
            };
            const req = store.put(cacheObj, "trades_data");
            req.onsuccess = () => resolve(true);
            req.onerror = () => reject(req.onerror);
        });
    } catch (err) {
        console.error("IndexedDB write error:", err);
    }
}

async function clearCache() {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const req = store.delete("trades_data");
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    } catch (err) {
        return false;
    }
}

// --- DATA INGESTION & BOOTSTRAP ---
document.addEventListener("DOMContentLoaded", async () => {
    // Initialize Lucide Icons
    if (window.lucide) {
        window.lucide.createIcons();
    }
    
    // Set up event listeners
    setupEventListeners();
    setupTabNavigation();
    
    // Load dataset
    await loadData();
    
    // Load active price alerts
    await loadAlerts();
});

async function loadData(forceRefresh = false) {
    const statusText = document.getElementById("cache-status");
    const indicator = document.querySelector(".pulse-indicator");
    
    statusText.textContent = "Checking cache...";
    
    let cache = null;
    if (!forceRefresh) {
        cache = await getCachedTrades();
    }
    
    if (cache) {
        allTrades = cache.data;
        const hoursAgo = Math.round((Date.now() - cache.timestamp) / (60 * 60 * 1000));
        statusText.textContent = `Cached Data (${hoursAgo}h old)`;
        indicator.style.backgroundColor = "#4facfe"; // blue for cache
        processLoadedData();
    } else {
        statusText.textContent = "Fetching live trades...";
        indicator.style.backgroundColor = "#fbbf24"; // amber for downloading
        try {
            const response = await fetch(DATA_URL);
            if (!response.ok) throw new Error("HTTP error: " + response.status);
            const data = await response.json();
            
            allTrades = data;
            await saveTradesToCache(data);
            
            statusText.textContent = "Live Data Synced";
            indicator.style.backgroundColor = "#10b981"; // emerald for live success
            processLoadedData();
        } catch (err) {
            console.error("Fetch failed:", err);
            // Try fallback to expired cache
            const fallbackCache = await getCachedTradesFallback();
            if (fallbackCache) {
                allTrades = fallbackCache.data;
                statusText.textContent = "Offline Mode (Expired Cache)";
                indicator.style.backgroundColor = "#f43f5e"; // red for fallback warning
                processLoadedData();
            } else {
                statusText.textContent = "Failed to load data";
                indicator.style.backgroundColor = "#f43f5e";
                document.getElementById("table-body").innerHTML = `
                    <tr>
                        <td colspan="8" class="empty-state">
                            <i data-lucide="alert-triangle" style="width: 48px; height: 48px; color: var(--color-accent-red); margin-bottom: 12px;"></i>
                            <p>Network Error: Unable to fetch disclosures and no cached data exists.</p>
                            <button class="btn btn-secondary btn-small" onclick="loadData(true)" style="margin-top: 12px;">Retry Ingestion</button>
                        </td>
                    </tr>
                `;
                if (window.lucide) window.lucide.createIcons();
            }
        }
    }
}

function processLoadedData() {
    applyFilters();
}

// --- CORE LOGIC: FILTERING, SEARCH, PRESETS ---
function applyFilters() {
    currentPage = 1;
    const searchLower = filterSearch.toLowerCase().trim();
    
    filteredTrades = allTrades.filter(trade => {
        // 1. Text Search
        if (searchLower) {
            const filerMatch = (trade.filer_name || "").toLowerCase().includes(searchLower);
            const tickerMatch = (trade.ticker || "").toLowerCase().includes(searchLower);
            const assetMatch = (trade.asset_name || "").toLowerCase().includes(searchLower);
            if (!filerMatch && !tickerMatch && !assetMatch) return false;
        }
        
        // 2. Chamber Filter
        if (filterChamber !== "all") {
            if (trade.chamber !== filterChamber) return false;
        }
        
        // 3. Transaction Type Filter
        if (filterType !== "all") {
            const tType = (trade.transaction_type || "").toLowerCase();
            if (filterType === "buy" && !tType.includes("purchase")) return false;
            if (filterType === "sell" && !tType.includes("sale")) return false;
            if (filterType === "exchange" && !tType.includes("exchange")) return false;
        }
        
        // 4. Size Range Filter
        const midSize = calculateMidpoint(trade);
        if (midSize < filterMinSize || midSize > filterMaxSize) return false;
        
        return true;
    });
    
    // Sort and Render
    sortData(currentSortField, currentSortDirection, false);
    
    // Refresh GUI Elements
    updateMetrics();
    updateCharts();
    renderTable();
}

function calculateMidpoint(trade) {
    const low = trade.amount_range_low || 0;
    const high = trade.amount_range_high || null;
    
    if (high === null) return low; // Open ended range (e.g. $1M+)
    return (low + high) / 2;
}

function setupEventListeners() {
    // Search input
    const searchInput = document.getElementById("search-input");
    searchInput.addEventListener("input", (e) => {
        filterSearch = e.target.value;
        applyFilters();
    });
    
    // Chamber radios
    const chamberRadios = document.getElementsByName("chamber");
    chamberRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            filterChamber = e.target.value;
            applyFilters();
        });
    });
    
    // Transaction type dropdown
    const transactionSelect = document.getElementById("transaction-select");
    transactionSelect.addEventListener("change", (e) => {
        filterType = e.target.value;
        applyFilters();
    });
    
    // Amount range presets
    const rangePresets = document.querySelectorAll(".range-presets .btn-preset");
    rangePresets.forEach(btn => {
        btn.addEventListener("click", () => {
            rangePresets.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            filterMinSize = parseFloat(btn.getAttribute("data-min"));
            filterMaxSize = parseFloat(btn.getAttribute("data-max"));
            applyFilters();
        });
    });
    
    // Reset Filters
    document.getElementById("reset-filters-btn").addEventListener("click", () => {
        searchInput.value = "";
        filterSearch = "";
        
        document.getElementById("chamber-all").checked = true;
        filterChamber = "all";
        
        transactionSelect.value = "all";
        filterType = "all";
        
        rangePresets.forEach(b => b.classList.remove("active"));
        rangePresets[0].classList.add("active");
        filterMinSize = 0;
        filterMaxSize = Infinity;
        
        applyFilters();
    });
    
    // Refresh & Clear Cache Button
    document.getElementById("clear-cache-btn").addEventListener("click", async () => {
        const btn = document.getElementById("clear-cache-btn");
        btn.classList.add("spinning");
        await clearCache();
        await loadData(true);
        setTimeout(() => btn.classList.remove("spinning"), 600);
    });
    
    // Table sorting triggers
    const tableHeaders = document.querySelectorAll("#transactions-table th.sortable");
    tableHeaders.forEach(th => {
        th.addEventListener("click", () => {
            const field = th.getAttribute("data-sort");
            let dir = "asc";
            if (currentSortField === field && currentSortDirection === "asc") {
                dir = "desc";
            }
            
            // Update UI headers
            tableHeaders.forEach(header => {
                const icon = header.querySelector(".sort-icon");
                icon.setAttribute("data-lucide", "chevrons-up-down");
            });
            const currentIcon = th.querySelector(".sort-icon");
            currentIcon.setAttribute("data-lucide", dir === "asc" ? "chevron-up" : "chevron-down");
            
            if (window.lucide) window.lucide.createIcons();
            
            sortData(field, dir, true);
        });
    });
    
    // Pagination buttons
    document.getElementById("prev-page-btn").addEventListener("click", () => {
        if (currentPage > 1) {
            currentPage--;
            renderTable();
        }
    });
    
    document.getElementById("next-page-btn").addEventListener("click", () => {
        const maxPage = Math.ceil(filteredTrades.length / itemsPerPage) || 1;
        if (currentPage < maxPage) {
            currentPage++;
            renderTable();
        }
    });
    
    // Export CSV
    document.getElementById("export-csv-btn").addEventListener("click", exportToCSV);
    
    // Quick Presets listeners
    document.getElementById("preset-past-30").addEventListener("click", () => applyPresetDays(30));
    document.getElementById("preset-past-year").addEventListener("click", () => applyPresetDays(365));
    document.getElementById("preset-house-dem").addEventListener("click", () => {
        document.getElementById("chamber-house").checked = true;
        filterChamber = "house";
        transactionSelect.value = "buy";
        filterType = "buy";
        applyFilters();
    });
    document.getElementById("preset-senate-rep").addEventListener("click", () => {
        document.getElementById("chamber-senate").checked = true;
        filterChamber = "senate";
        transactionSelect.value = "sell";
        filterType = "sell";
        applyFilters();
    });
}

function applyPresetDays(days) {
    if (allTrades.length === 0) return;
    
    // Find the latest transaction date in the dataset to act as "anchor" due to reporting delay
    let maxDate = new Date();
    const dates = allTrades.map(t => t.transaction_date).filter(Boolean);
    if (dates.length > 0) {
        maxDate = new Date(dates.reduce((a, b) => a > b ? a : b));
    }
    
    const cutoffDate = new Date(maxDate);
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    filteredTrades = allTrades.filter(trade => {
        if (!trade.transaction_date) return false;
        const tradeDate = new Date(trade.transaction_date);
        return tradeDate >= cutoffDate && tradeDate <= maxDate;
    });
    
    // Reset filters visual indicators to avoid confusion
    document.getElementById("search-input").value = "";
    filterSearch = "";
    document.getElementById("chamber-all").checked = true;
    filterChamber = "all";
    document.getElementById("transaction-select").value = "all";
    filterType = "all";
    
    sortData(currentSortField, currentSortDirection, false);
    updateMetrics();
    updateCharts();
    renderTable();
}

// --- DATA PROCESSING & SORTING ---
function sortData(field, direction, render = true) {
    currentSortField = field;
    currentSortDirection = direction;
    
    filteredTrades.sort((a, b) => {
        let valA, valB;
        
        if (field === "transaction_date") {
            valA = new Date(a.transaction_date || "1970-01-01");
            valB = new Date(b.transaction_date || "1970-01-01");
        } else if (field === "representative") {
            valA = (a.filer_name || "").toLowerCase();
            valB = (b.filer_name || "").toLowerCase();
        } else if (field === "amount_value") {
            valA = calculateMidpoint(a);
            valB = calculateMidpoint(b);
        } else {
            valA = a[field];
            valB = b[field];
        }
        
        if (valA < valB) return direction === "asc" ? -1 : 1;
        if (valA > valB) return direction === "asc" ? 1 : -1;
        return 0;
    });
    
    if (render) {
        currentPage = 1;
        renderTable();
    }
}

// --- KPI METRICS CALCULATIONS ---
function updateMetrics() {
    const totalCount = filteredTrades.length;
    document.getElementById("kpi-total-trades").textContent = totalCount.toLocaleString();
    
    // Calculate date ranges to show duration in subtext
    const subtext = document.getElementById("kpi-trades-sub");
    if (totalCount > 0) {
        const dates = filteredTrades.map(t => t.transaction_date).filter(Boolean);
        if (dates.length > 0) {
            const minStr = dates.reduce((a, b) => a < b ? a : b);
            const maxStr = dates.reduce((a, b) => a > b ? a : b);
            subtext.textContent = `${formatDateShort(minStr)} to ${formatDateShort(maxStr)}`;
        }
    } else {
        subtext.textContent = "No trades in active filters";
    }
    
    // Est. Volume calculation
    let estVolume = 0;
    let buyCount = 0;
    let sellCount = 0;
    const tickerFrequencies = {};
    
    filteredTrades.forEach(trade => {
        estVolume += calculateMidpoint(trade);
        
        const type = (trade.transaction_type || "").toLowerCase();
        if (type.includes("purchase")) buyCount++;
        if (type.includes("sale")) sellCount++;
        
        if (trade.ticker && trade.ticker !== "--") {
            tickerFrequencies[trade.ticker] = (tickerFrequencies[trade.ticker] || 0) + 1;
        }
    });
    
    // Display Volume
    document.getElementById("kpi-volume").textContent = formatCurrency(estVolume);
    
    // Display Buys vs Sells
    const ratioVal = document.getElementById("kpi-buy-sell");
    const ratioSub = document.getElementById("kpi-ratio-sub");
    if (buyCount + sellCount > 0) {
        const buyPct = Math.round((buyCount / (buyCount + sellCount)) * 100);
        ratioVal.textContent = `${buyPct}% Buy`;
        ratioSub.textContent = `${buyCount.toLocaleString()} Buys / ${sellCount.toLocaleString()} Sells`;
    } else {
        ratioVal.textContent = "-";
        ratioSub.textContent = "0 transactions";
    }
    
    // Top Ticker
    const topTickerEl = document.getElementById("kpi-top-ticker");
    const topTickerSub = document.getElementById("kpi-ticker-sub");
    const sortedTickers = Object.entries(tickerFrequencies).sort((a, b) => b[1] - a[1]);
    
    if (sortedTickers.length > 0) {
        topTickerEl.textContent = sortedTickers[0][0];
        topTickerSub.textContent = `${sortedTickers[0][1]} trades in dataset`;
    } else {
        topTickerEl.textContent = "-";
        topTickerSub.textContent = "No tickers found";
    }
    
    // Filter Badge count
    document.getElementById("filtered-count-badge").textContent = `${totalCount.toLocaleString()} matching trades`;
}

// --- RENDER REGISTRY TABLE ---
function renderTable() {
    const tbody = document.getElementById("table-body");
    const totalFiltered = filteredTrades.length;
    
    if (totalFiltered === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="empty-state">
                    <i data-lucide="search-x" style="width: 48px; height: 48px; color: var(--text-muted); margin-bottom: 12px;"></i>
                    <p>No matching stock transactions found. Adjust your active filters.</p>
                </td>
            </tr>
        `;
        document.getElementById("page-start").textContent = "0";
        document.getElementById("page-end").textContent = "0";
        document.getElementById("total-filtered").textContent = "0";
        document.getElementById("prev-page-btn").disabled = true;
        document.getElementById("next-page-btn").disabled = true;
        document.getElementById("current-page-num").textContent = "Page 1 of 1";
        
        if (window.lucide) window.lucide.createIcons();
        return;
    }
    
    const maxPage = Math.ceil(totalFiltered / itemsPerPage) || 1;
    if (currentPage > maxPage) currentPage = maxPage;
    
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalFiltered);
    const paginatedItems = filteredTrades.slice(startIndex, endIndex);
    
    let html = "";
    paginatedItems.forEach(trade => {
        const rawDate = trade.transaction_date || "—";
        const formattedDate = rawDate !== "—" ? formatDate(rawDate) : "—";
        
        // Chamber Badge
        let chamberBadgeHtml = "—";
        if (trade.chamber === "senate") {
            chamberBadgeHtml = `<span class="badge-chamber senate">Senate</span>`;
        } else if (trade.chamber === "house") {
            chamberBadgeHtml = `<span class="badge-chamber house">House</span>`;
        } else if (trade.branch === "executive") {
            chamberBadgeHtml = `<span class="badge-chamber" style="background: rgba(245, 158, 11, 0.12); color: #fbbf24;">Executive</span>`;
        }
        
        // Transaction Type Badge
        let typeBadgeHtml = `<span class="badge-type">${trade.transaction_type}</span>`;
        const rawType = (trade.transaction_type || "").toLowerCase();
        if (rawType.includes("purchase")) {
            typeBadgeHtml = `<span class="badge-type buy">Buy</span>`;
        } else if (rawType.includes("sale")) {
            typeBadgeHtml = `<span class="badge-type sell">Sell</span>`;
        } else if (rawType.includes("exchange")) {
            typeBadgeHtml = `<span class="badge-type exchange">Exch</span>`;
        }
        
        // Filer Name & Metadata
        const partyLabel = trade.party ? ` (${trade.party}-${trade.state || ""})` : "";
        const filerDisplay = `<span class="filer-name">${trade.filer_name}</span><br><span style="font-size: 0.75rem; color: var(--text-muted);">${trade.office || ""}${partyLabel}</span>`;
        
        // Ticker
        const ticker = trade.ticker && trade.ticker !== "--" ? `<span class="ticker-label">${trade.ticker}</span>` : `<span style="color: var(--text-muted);">—</span>`;
        
        // Asset details tooltip/name
        const assetName = trade.asset_name || "—";
        const assetDisplay = `<div class="asset-details" title="${assetName}">${assetName}</div>`;
        
        // Amount label
        const amountDisplay = `<span class="filer-name">${trade.amount_range_label || "—"}</span>`;
        
        // Document pdf link
        const docUrl = trade.doc_url ? `<a href="${trade.doc_url}" target="_blank" class="btn-pdf" title="Original PDF Disclosure"><i data-lucide="file-text"></i></a>` : "—";
        
        html += `
            <tr>
                <td>${formattedDate}</td>
                <td>${filerDisplay}</td>
                <td>${chamberBadgeHtml}</td>
                <td>${ticker}</td>
                <td>${assetDisplay}</td>
                <td>${typeBadgeHtml}</td>
                <td class="text-right">${amountDisplay}</td>
                <td class="text-center">${docUrl}</td>
            </tr>
        `;
    });
    
    tbody.innerHTML = html;
    
    // Update Pagination Indicators
    document.getElementById("page-start").textContent = (startIndex + 1).toLocaleString();
    document.getElementById("page-end").textContent = endIndex.toLocaleString();
    document.getElementById("total-filtered").textContent = totalFiltered.toLocaleString();
    document.getElementById("current-page-num").textContent = `Page ${currentPage} of ${maxPage}`;
    
    document.getElementById("prev-page-btn").disabled = currentPage === 1;
    document.getElementById("next-page-btn").disabled = currentPage === maxPage;
    
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

// --- DATA VISUALIZATIONS (CHART.JS) ---
function updateCharts() {
    const ctxVolume = document.getElementById("volume-trend-chart").getContext("2d");
    const ctxStocks = document.getElementById("top-stocks-chart").getContext("2d");
    const ctxPoliticians = document.getElementById("top-politicians-chart").getContext("2d");
    
    // 1. Data Aggregation for Charts
    const monthlyData = {};
    const stockData = {};
    const politicianData = {};
    
    filteredTrades.forEach(trade => {
        // Monthly trend grouping (YYYY-MM)
        if (trade.transaction_date) {
            const monthStr = trade.transaction_date.substring(0, 7); // '2026-05'
            monthlyData[monthStr] = (monthlyData[monthStr] || 0) + 1;
        }
        
        // Top Stocks grouping
        if (trade.ticker && trade.ticker !== "--") {
            stockData[trade.ticker] = (stockData[trade.ticker] || 0) + 1;
        }
        
        // Top Politicians grouping
        if (trade.filer_name) {
            politicianData[trade.filer_name] = (politicianData[trade.filer_name] || 0) + 1;
        }
    });
    
    // Sort and slice charts data
    const sortedMonths = Object.keys(monthlyData).sort();
    const monthCounts = sortedMonths.map(m => monthlyData[m]);
    
    const sortedStocks = Object.entries(stockData).sort((a,b) => b[1] - a[1]).slice(0, 8);
    const stockLabels = sortedStocks.map(s => s[0]);
    const stockCounts = sortedStocks.map(s => s[1]);
    
    const sortedPoliticians = Object.entries(politicianData).sort((a,b) => b[1] - a[1]).slice(0, 8);
    const politicianLabels = sortedPoliticians.map(p => p[0]);
    const politicianCounts = sortedPoliticians.map(p => p[1]);
    
    // Theme options common
    const chartDefaults = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: "rgba(11, 15, 25, 0.9)",
                titleFont: { family: "Outfit", size: 12 },
                bodyFont: { family: "Plus Jakarta Sans", size: 12 },
                borderColor: "rgba(255, 255, 255, 0.1)",
                borderWidth: 1,
                padding: 10,
                displayColors: false
            }
        },
        scales: {
            x: {
                grid: { color: "rgba(255, 255, 255, 0.03)" },
                ticks: { color: "#94a3b8", font: { family: "Plus Jakarta Sans", size: 10 } }
            },
            y: {
                grid: { color: "rgba(255, 255, 255, 0.03)" },
                ticks: { color: "#94a3b8", font: { family: "Plus Jakarta Sans", size: 10 } }
            }
        }
    };

    // --- Chart 1: Volume Trend (Line Chart) ---
    if (volumeChart) volumeChart.destroy();
    volumeChart = new Chart(ctxVolume, {
        type: "line",
        data: {
            labels: sortedMonths.map(formatMonthName),
            datasets: [{
                data: monthCounts,
                borderColor: "#00f2fe",
                backgroundColor: "rgba(0, 242, 254, 0.05)",
                fill: true,
                tension: 0.35,
                borderWidth: 2,
                pointBackgroundColor: "#4facfe",
                pointHoverRadius: 6
            }]
        },
        options: {
            ...chartDefaults,
            scales: {
                ...chartDefaults.scales,
                y: {
                    ...chartDefaults.scales.y,
                    beginAtZero: true
                }
            }
        }
    });

    // --- Chart 2: Top Stocks (Horizontal Bar) ---
    if (stocksChart) stocksChart.destroy();
    stocksChart = new Chart(ctxStocks, {
        type: "bar",
        data: {
            labels: stockLabels,
            datasets: [{
                data: stockCounts,
                backgroundColor: "rgba(79, 172, 254, 0.75)",
                borderColor: "#4facfe",
                borderWidth: 1,
                borderRadius: 4,
                hoverBackgroundColor: "#00f2fe"
            }]
        },
        options: {
            ...chartDefaults,
            indexAxis: 'y',
            interaction: {
                mode: 'index',
                intersect: false,
                axis: 'y'
            },
            onClick: (event, elements) => {
                if (elements && elements.length > 0) {
                    const index = elements[0].index;
                    const label = stockLabels[index];
                    document.getElementById("search-input").value = label;
                    filterSearch = label;
                    applyFilters();
                }
            },
            onHover: (event, chartElement) => {
                event.native.target.style.cursor = (chartElement && chartElement.length > 0) ? 'pointer' : 'default';
            },
            scales: {
                x: {
                    grid: { color: "rgba(255, 255, 255, 0.03)" },
                    ticks: { color: "#94a3b8", precision: 0 }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: "#f8fafc", font: { family: "Plus Jakarta Sans", size: 11 } }
                }
            }
        }
    });

    // --- Chart 3: Top Politicians (Horizontal Bar) ---
    if (politiciansChart) politiciansChart.destroy();
    politiciansChart = new Chart(ctxPoliticians, {
        type: "bar",
        data: {
            labels: politicianLabels,
            datasets: [{
                data: politicianCounts,
                backgroundColor: "rgba(167, 139, 250, 0.75)",
                borderColor: "#a78bfa",
                borderWidth: 1,
                borderRadius: 4,
                hoverBackgroundColor: "#c084fc"
            }]
        },
        options: {
            ...chartDefaults,
            indexAxis: 'y',
            interaction: {
                mode: 'index',
                intersect: false,
                axis: 'y'
            },
            onClick: (event, elements) => {
                if (elements && elements.length > 0) {
                    const index = elements[0].index;
                    const label = politicianLabels[index];
                    document.getElementById("search-input").value = label;
                    filterSearch = label;
                    applyFilters();
                }
            },
            onHover: (event, chartElement) => {
                event.native.target.style.cursor = (chartElement && chartElement.length > 0) ? 'pointer' : 'default';
            },
            scales: {
                x: {
                    grid: { color: "rgba(255, 255, 255, 0.03)" },
                    ticks: { color: "#94a3b8", precision: 0 }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: "#f8fafc", font: { family: "Plus Jakarta Sans", size: 11 } }
                }
            }
        }
    });
}

// --- UTILITY FORMATTERS ---
function calculateVolumeMidpoint(trade) {
    return calculateMidpoint(trade);
}

function formatCurrency(val) {
    if (val >= 1e9) {
        return "$" + (val / 1e9).toFixed(1) + "B";
    }
    if (val >= 1e6) {
        return "$" + (val / 1e6).toFixed(1) + "M";
    }
    if (val >= 1e3) {
        return "$" + (val / 1e3).toFixed(0) + "K";
    }
    return "$" + val.toString();
}

function formatDate(dateString) {
    const parts = dateString.split('-');
    if (parts.length !== 3) return dateString;
    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    
    // Short month names array
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mIdx = parseInt(month, 10) - 1;
    if (mIdx < 0 || mIdx > 11) return dateString;
    
    return `${months[mIdx]} ${parseInt(day, 10)}, ${year}`;
}

function formatDateShort(dateString) {
    const parts = dateString.split('-');
    if (parts.length !== 3) return dateString;
    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    return `${month}/${day}/${year.slice(2)}`;
}

function formatMonthName(monthStr) {
    const parts = monthStr.split('-');
    if (parts.length !== 2) return monthStr;
    const year = parts[0];
    const month = parts[1];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mIdx = parseInt(month, 10) - 1;
    if (mIdx < 0 || mIdx > 11) return monthStr;
    return `${months[mIdx]} '${year.slice(2)}`;
}

// --- CSV EXPORTER ---
function exportToCSV() {
    if (filteredTrades.length === 0) return;
    
    const headers = ["Filing ID", "Transaction Date", "Filing Date", "Filer Name", "Chamber", "Party", "State", "Ticker", "Asset Name", "Transaction Type", "Amount Range", "Filing URL"];
    
    const rows = filteredTrades.map(trade => [
        trade.id || "",
        trade.transaction_date || "",
        trade.filing_date || "",
        trade.filer_name || "",
        trade.chamber || "",
        trade.party || "",
        trade.state || "",
        trade.ticker || "",
        `"${(trade.asset_name || "").replace(/"/g, '""')}"`,
        trade.transaction_type || "",
        trade.amount_range_label || "",
        trade.doc_url || ""
    ]);
    
    let csvContent = "data:text/csv;charset=utf-8," 
        + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
        
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    
    const searchPart = filterSearch ? `_${filterSearch.replace(/[^a-zA-Z0-9]/g, "")}` : "";
    link.setAttribute("download", `congress_trades_${filterChamber}${searchPart}.csv`);
    document.body.appendChild(link);
    
    link.click();
    document.body.removeChild(link);
}

// --- ACTIVE PRICE ALERTS HANDLERS ---
function setupTabNavigation() {
    const tabLedger = document.getElementById("tab-ledger");
    const tabAlerts = document.getElementById("tab-alerts");
    const ledgerPanel = document.getElementById("ledger-panel");
    const alertsPanel = document.getElementById("alerts-panel");
    const sidebarFilters = document.getElementById("sidebar-filters-container");
    
    tabLedger.addEventListener("click", () => {
        tabLedger.classList.add("active");
        tabAlerts.classList.remove("active");
        ledgerPanel.style.display = "block";
        alertsPanel.style.display = "none";
        sidebarFilters.style.display = "flex";
    });
    
    tabAlerts.addEventListener("click", () => {
        tabAlerts.classList.add("active");
        tabLedger.classList.remove("active");
        ledgerPanel.style.display = "none";
        alertsPanel.style.display = "block";
        sidebarFilters.style.display = "none";
        loadAlerts(); // Load alerts dynamically
    });
}

async function loadAlerts() {
    const container = document.getElementById("alerts-container");
    const mainBadge = document.getElementById("alerts-count-badge-main");
    const headerBadge = document.getElementById("alerts-count-badge");
    
    try {
        const response = await fetch("alerts.json");
        if (!response.ok) throw new Error("Alerts database not initialized");
        const alerts = await response.json();
        
        const count = alerts.length;
        mainBadge.textContent = `${count} active alerts`;
        
        if (count > 0) {
            headerBadge.textContent = count;
            headerBadge.style.display = "inline-block";
            
            let html = "";
            alerts.forEach(alert => {
                const badgeClass = alert.alert_type === "BUY_OPPORTUNITY" ? "buy" : "sell";
                const badgeText = alert.alert_type === "BUY_OPPORTUNITY" ? "Buy Opportunity" : "Sell Hit";
                const diffClass = alert.diff_pct < 0 ? "green" : "red";
                const sign = alert.diff_pct > 0 ? "+" : "";
                
                const partyLabel = alert.party ? ` (${alert.party}-${alert.state || ""})` : "";
                const dateStr = formatDate(alert.transaction_date);
                
                html += `
                    <div class="alert-card glass">
                        <div class="alert-card-header">
                            <span class="alert-badge ${badgeClass}">${badgeText}</span>
                            <span class="alert-ticker-badge">${alert.ticker}</span>
                        </div>
                        <div>
                            <h4 class="alert-card-title">${alert.filer_name}${partyLabel}</h4>
                            <p class="alert-card-subtitle">Traded on ${dateStr} • ${alert.amount_range_label}</p>
                        </div>
                        <div class="alert-comparison-box">
                            <div class="alert-comp-col">
                                <span class="alert-comp-label">Entry Price</span>
                                <span class="alert-comp-val">$${alert.hist_price.toFixed(2)}</span>
                            </div>
                            <div class="alert-diff-pill ${diffClass}">
                                ${sign}${alert.diff_pct.toFixed(1)}%
                            </div>
                            <div class="alert-comp-col text-right">
                                <span class="alert-comp-label">Current Price</span>
                                <span class="alert-comp-val">$${alert.current_price.toFixed(2)}</span>
                            </div>
                        </div>
                        <div class="alert-card-footer">
                            <span>Daily Monitor Alert</span>
                            <a href="${alert.doc_url}" target="_blank">View PDF <i data-lucide="external-link" style="width: 12px; height: 12px; vertical-align: middle;"></i></a>
                        </div>
                    </div>
                `;
            });
            container.innerHTML = html;
        } else {
            headerBadge.style.display = "none";
            container.innerHTML = `
                <div class="empty-state">
                    <i data-lucide="bell" style="width: 48px; height: 48px; color: var(--text-muted); margin-bottom: 12px; display: inline-block;"></i>
                    <p>No active price alerts. Stock prices are currently within entry/exit ranges.</p>
                </div>
            `;
        }
    } catch (err) {
        mainBadge.textContent = "0 active alerts";
        headerBadge.style.display = "none";
        container.innerHTML = `
            <div class="empty-state">
                <i data-lucide="bell" style="width: 48px; height: 48px; color: var(--text-muted); margin-bottom: 12px; display: inline-block;"></i>
                <p>No alerts generated yet. Configure credentials and execute the background price monitor.</p>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 8px;">Run command: <code>python monitor.py</code></div>
            </div>
        `;
    }
    
    if (window.lucide) {
        window.lucide.createIcons();
    }
}
