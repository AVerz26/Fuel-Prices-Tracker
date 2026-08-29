/**
 * Menor Preço MT - Interactive Dashboard Logic
 * Autenticação via Google Firebase (Google 1-Clique / E-mail) + Firestore + Mapa Leaflet + Evolução Temporal + Paridade 70%
 */

// Estado Global da Aplicação
const state = {
    firebaseApp: null,
    db: null,
    currentUser: null,
    allData: [],
    filteredData: [],
    currentFuel: 'ALL',
    currentCity: 'ALL',
    searchQuery: '',
    currentSort: 'price-asc',
    currentPage: 1,
    itemsPerPage: 10,
    map: null,
    markersGroup: null,
    charts: {
        priceEvolution: null,
        parity: null,
        cityComparison: null
    }
};

// Paleta de cores para os combustíveis
const FUEL_COLORS = {
    'ETANOL': { bg: 'rgba(16, 185, 129, 0.2)', border: '#10b981', class: 'etanol', icon: 'fa-leaf' },
    'GASOLINA COMUM': { bg: 'rgba(245, 158, 11, 0.2)', border: '#f59e0b', class: 'gasolina-comum', icon: 'fa-gas-pump' },
    'GASOLINA ADITIVADA': { bg: 'rgba(236, 72, 153, 0.2)', border: '#ec4899', class: 'gasolina-aditivada', icon: 'fa-fire' },
    'DIESEL S10': { bg: 'rgba(6, 182, 212, 0.2)', border: '#06b6d4', class: 'diesel-s10', icon: 'fa-truck' },
    'DIESEL S500': { bg: 'rgba(139, 92, 246, 0.2)', border: '#8b5cf6', class: 'diesel-s500', icon: 'fa-truck-moving' }
};

const DEFAULT_MT_CENTER = [-15.552, -54.283]; // Centro de MT (Primavera do Leste)

// Inicialização da Aplicação
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initEventListeners();
    initFirebase();
});

// 1. Inicialização do Firebase
function initFirebase() {
    const savedApiKey = localStorage.getItem('firebase_api_key') || (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey);
    const savedProjectId = localStorage.getItem('firebase_project_id') || (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId);
    const savedAuthDomain = localStorage.getItem('firebase_auth_domain') || (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.authDomain);

    if (savedApiKey) document.getElementById('cfgApiKey').value = savedApiKey;
    if (savedProjectId) document.getElementById('cfgProjectId').value = savedProjectId;
    if (savedAuthDomain) document.getElementById('cfgAuthDomain').value = savedAuthDomain;

    if (!savedApiKey || !savedProjectId) {
        showAuthAlert('Chaves do Firebase não configuradas. Clique em "Configurações do Firebase" abaixo.', 'warning');
        return;
    }

    const firebaseConfig = {
        apiKey: savedApiKey,
        projectId: savedProjectId,
        authDomain: savedAuthDomain || `${savedProjectId}.firebaseapp.com`
    };

    try {
        if (!firebase.apps.length) {
            state.firebaseApp = firebase.initializeApp(firebaseConfig);
        } else {
            state.firebaseApp = firebase.app();
        }

        state.db = firebase.firestore();

        // Monitora estado de autenticação em tempo real
        firebase.auth().onAuthStateChanged(user => {
            if (user) {
                state.currentUser = user;
                showDashboardView(user);
                loadDataFromFirestore();
            } else {
                state.currentUser = null;
                showLoginView();
            }
        });

    } catch (err) {
        console.error('Erro ao inicializar Firebase:', err);
        showAuthAlert('Erro ao conectar com Firebase. Verifique as chaves fornecidas.');
    }
}

// 2. Login com Google (1 clique)
async function handleGoogleLogin() {
    hideAuthAlert();
    if (!state.firebaseApp) {
        showAuthAlert('Configure as chaves do Firebase antes de logar.');
        return;
    }

    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        await firebase.auth().signInWithPopup(provider);
    } catch (err) {
        console.error('Erro no login com Google:', err);
        showAuthAlert(`Erro ao conectar com Google: ${err.message}`);
    }
}

// 3. Login com E-mail e Senha
async function handleLogin(e) {
    e.preventDefault();
    hideAuthAlert();

    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!state.firebaseApp) {
        showAuthAlert('Configure as chaves do Firebase antes de logar.');
        return;
    }

    setLoginLoading(true);

    try {
        await firebase.auth().signInWithEmailAndPassword(email, password);
    } catch (err) {
        console.error('Erro no login:', err);
        let msg = 'Erro ao efetuar login. Verifique suas credenciais.';
        if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
            msg = 'E-mail ou senha incorretos.';
        } else if (err.message) {
            msg = err.message;
        }
        showAuthAlert(msg);
    } finally {
        setLoginLoading(false);
    }
}

// 4. Logout
async function handleLogout() {
    if (state.firebaseApp) {
        await firebase.auth().signOut();
    }
    state.currentUser = null;
    state.allData = [];
    state.filteredData = [];
    showLoginView();
}

// 5. Carregamento dos Dados do Firestore (Protegido por Security Rules)
async function loadDataFromFirestore() {
    const recordsBadge = document.getElementById('recordsBadge');
    const syncBadge = document.getElementById('lastUpdatedText');
    recordsBadge.innerText = 'Consultando Firestore...';

    try {
        const snapshot = await state.db.collection('precos').get();

        const docs = [];
        snapshot.forEach(doc => {
            const item = doc.data();
            docs.push({
                id: item.id || doc.id,
                nome_emissor: item.nome_emissor || '',
                desc_produto: item.desc_produto || '',
                valor: parseFloat(item.valor_unidade_comercial || item.valor || 0),
                municipio: (item.nome_municipio_emissor || item.municipio || '').toUpperCase().trim(),
                latitude: item.latitude ? parseFloat(item.latitude) : null,
                longitude: item.longitude ? parseFloat(item.longitude) : null,
                distancia: item.distancia ? parseFloat(item.distancia) : 0.0,
                data_emissao: item.data_emissao || ''
            });
        });

        // Ordena por data mais recente
        docs.sort((a, b) => new Date(b.data_emissao) - new Date(a.data_emissao));
        state.allData = docs;

        if (state.allData.length > 0) {
            const latestDate = state.allData[0].data_emissao;
            updateSyncBadge(latestDate);
        } else {
            syncBadge.innerText = 'Base autenticada (vazia)';
        }

        populateCityFilter(state.allData);
        applyFilters();

    } catch (err) {
        console.error('Falha ao consultar Firestore:', err);
        recordsBadge.innerText = 'Erro ao carregar dados';
        showEmptyState(`Não foi possível carregar os preços: ${err.message || 'Verifique as Regras de Segurança (Security Rules) do Firestore.'}`);
    }
}

// 6. Atualização do Badge de Sincronização
function updateSyncBadge(lastUpdated) {
    const badge = document.getElementById('lastUpdatedText');
    if (lastUpdated) {
        const dt = new Date(lastUpdated);
        const formatted = dt.toLocaleString('pt-BR', { 
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit' 
        });
        badge.innerText = `Atualizado em ${formatted}`;
    } else {
        badge.innerText = `Sessão ativa e protegida`;
    }
}

// 7. Popula Cidades no Dropdown
function populateCityFilter(data) {
    const citySelect = document.getElementById('citySelect');
    const cities = [...new Set(data.map(item => item.municipio))].filter(Boolean).sort();
    
    citySelect.innerHTML = '<option value="ALL">Todas as Cidades</option>';
    cities.forEach(city => {
        const option = document.createElement('option');
        option.value = city;
        option.textContent = city;
        citySelect.appendChild(option);
    });
}

// 8. Renderização dos KPI Cards
function renderKpiCards() {
    const container = document.getElementById('kpisContainer');
    container.innerHTML = '';

    const fuels = ['ETANOL', 'GASOLINA COMUM', 'GASOLINA ADITIVADA', 'DIESEL S10', 'DIESEL S500'];
    
    fuels.forEach(fuel => {
        const fuelItems = state.filteredData.filter(d => d.desc_produto === fuel);
        if (fuelItems.length === 0) return;

        const cheapest = fuelItems.reduce((min, cur) => cur.valor < min.valor ? cur : min, fuelItems[0]);
        const style = FUEL_COLORS[fuel] || { border: '#3b82f6', bg: 'rgba(59, 130, 246, 0.15)', icon: 'fa-gas-pump' };

        const card = document.createElement('div');
        card.className = 'kpi-card';
        card.style.setProperty('--card-accent', style.border);
        card.style.setProperty('--card-icon-bg', style.bg);

        card.innerHTML = `
            <div class="kpi-header">
                <span class="kpi-title">${fuel}</span>
                <div class="kpi-icon">
                    <i class="fa-solid ${style.icon}"></i>
                </div>
            </div>
            <div class="kpi-body">
                <span class="kpi-price">R$ ${cheapest.valor.toFixed(2)}</span>
                <span class="kpi-unit">/ litro</span>
            </div>
            <div class="kpi-footer">
                <span class="kpi-station-name" title="${cheapest.nome_emissor}">
                    <i class="fa-solid fa-store"></i> ${cheapest.nome_emissor}
                </span>
                <span><i class="fa-solid fa-location-dot"></i> ${cheapest.municipio}</span>
            </div>
        `;

        container.appendChild(card);
    });
}

// 9. Cálculo de Paridade Etanol vs Gasolina (Regra dos 70%)
function renderParityCard() {
    const parityRatioValue = document.getElementById('parityRatioValue');
    const decisionBadge = document.getElementById('decisionBadge');
    const decisionDesc = document.getElementById('decisionDesc');
    const parityLocation = document.getElementById('parityLocation');

    const baseData = state.currentCity === 'ALL' ? state.allData : state.allData.filter(d => d.municipio === state.currentCity);
    
    const etanolItems = baseData.filter(d => d.desc_produto === 'ETANOL');
    const gasolinaItems = baseData.filter(d => d.desc_produto === 'GASOLINA COMUM');

    parityLocation.innerText = state.currentCity === 'ALL' 
        ? 'Média consolidada em todo o estado de Mato Grosso' 
        : `Média calculada para o município de ${state.currentCity}`;

    if (etanolItems.length === 0 || gasolinaItems.length === 0) {
        parityRatioValue.innerText = '--%';
        decisionBadge.className = 'decision-badge';
        decisionBadge.innerText = 'Dados insuficientes';
        decisionDesc.innerText = 'Não há dados simultâneos de Etanol e Gasolina para calcular a paridade.';
        return;
    }

    const avgEtanol = etanolItems.reduce((sum, item) => sum + item.valor, 0) / etanolItems.length;
    const avgGasolina = gasolinaItems.reduce((sum, item) => sum + item.valor, 0) / gasolinaItems.length;

    const ratio = (avgEtanol / avgGasolina) * 100;
    parityRatioValue.innerText = `${ratio.toFixed(1)}%`;

    if (ratio < 70) {
        const economy = (70 - ratio).toFixed(1);
        decisionBadge.className = 'decision-badge etanol';
        decisionBadge.innerHTML = `<i class="fa-solid fa-leaf"></i> Vantagem: ETANOL (+${economy}% mais econômico)`;
        decisionDesc.innerText = `O preço do etanol (R$ ${avgEtanol.toFixed(2)}) representa ${ratio.toFixed(1)}% do valor da gasolina (R$ ${avgGasolina.toFixed(2)}). Como está abaixo de 70%, o etanol gera maior economia por km rodado.`;
    } else {
        decisionBadge.className = 'decision-badge gasolina';
        decisionBadge.innerHTML = `<i class="fa-solid fa-gas-pump"></i> Vantagem: GASOLINA COMUM`;
        decisionDesc.innerText = `O preço do etanol (R$ ${avgEtanol.toFixed(2)}) atingiu ${ratio.toFixed(1)}% da gasolina (R$ ${avgGasolina.toFixed(2)}). Como ultrapassou os 70%, a gasolina oferece melhor custo-benefício.`;
    }
}

// 10. Inicialização e Renderização do Mapa Leaflet
function initMap() {
    if (state.map) return;

    state.map = L.map('map', {
        center: DEFAULT_MT_CENTER,
        zoom: 12,
        scrollWheelZoom: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(state.map);

    state.markersGroup = L.layerGroup().addTo(state.map);
}

function renderMap() {
    initMap();
    state.markersGroup.clearLayers();

    const validStations = state.filteredData.filter(d => d.latitude && d.longitude && !isNaN(d.latitude) && !isNaN(d.longitude));

    if (validStations.length === 0) {
        state.map.setView(DEFAULT_MT_CENTER, 7);
        return;
    }

    const prices = validStations.map(d => d.valor).sort((a, b) => a - b);
    const p25 = prices[Math.floor(prices.length * 0.25)] || prices[0];
    const p75 = prices[Math.floor(prices.length * 0.75)] || prices[prices.length - 1];

    const bounds = L.latLngBounds();

    validStations.forEach(item => {
        let pinClass = 'pin-medium';
        if (item.valor <= p25) {
            pinClass = 'pin-cheapest';
        } else if (item.valor >= p75) {
            pinClass = 'pin-expensive';
        }

        const iconHtml = `
            <div class="custom-map-pin ${pinClass}">
                <i class="fa-solid fa-gas-pump"></i>
            </div>
        `;

        const customIcon = L.divIcon({
            html: iconHtml,
            className: 'leaflet-custom-marker',
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            popupAnchor: [0, -18]
        });

        const fuelStyle = FUEL_COLORS[item.desc_produto] || { class: 'etanol' };
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${item.latitude},${item.longitude}`;

        const popupContent = `
            <div class="map-popup-card">
                <span class="badge-fuel ${fuelStyle.class}">${item.desc_produto}</span>
                <div class="popup-station-title">${item.nome_emissor}</div>
                <div class="popup-price-tag">R$ ${item.valor.toFixed(2)} <small style="font-size:0.75rem;color:var(--text-muted)">/L</small></div>
                <div class="popup-details">
                    <span><i class="fa-solid fa-location-dot"></i> ${item.municipio}</span>
                    <span><i class="fa-regular fa-clock"></i> ${formatDate(item.data_emissao)}</span>
                    ${item.distancia > 0 ? `<span><i class="fa-solid fa-route"></i> ${item.distancia.toFixed(1)} km</span>` : ''}
                </div>
                <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="popup-btn-route">
                    <i class="fa-solid fa-diamond-turn-right"></i> Traçar Rota
                </a>
            </div>
        `;

        const marker = L.marker([item.latitude, item.longitude], { icon: customIcon })
            .bindPopup(popupContent);

        state.markersGroup.addLayer(marker);
        bounds.extend([item.latitude, item.longitude]);
    });

    if (bounds.isValid()) {
        state.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }

    setTimeout(() => {
        if (state.map) state.map.invalidateSize();
    }, 200);
}

// 11. Aplicação dos Filtros
function applyFilters() {
    let result = [...state.allData];

    if (state.currentFuel !== 'ALL') {
        result = result.filter(item => item.desc_produto === state.currentFuel);
    }

    if (state.currentCity !== 'ALL') {
        result = result.filter(item => item.municipio === state.currentCity);
    }

    if (state.searchQuery.trim() !== '') {
        const query = state.searchQuery.toLowerCase().trim();
        result = result.filter(item => 
            (item.nome_emissor && item.nome_emissor.toLowerCase().includes(query)) ||
            (item.municipio && item.municipio.toLowerCase().includes(query)) ||
            (item.desc_produto && item.desc_produto.toLowerCase().includes(query)) ||
            (item.id && item.id.toLowerCase().includes(query))
        );
    }

    switch (state.currentSort) {
        case 'price-asc':
            result.sort((a, b) => a.valor - b.valor);
            break;
        case 'price-desc':
            result.sort((a, b) => b.valor - a.valor);
            break;
        case 'date-desc':
            result.sort((a, b) => new Date(b.data_emissao) - new Date(a.data_emissao));
            break;
        case 'distance-asc':
            result.sort((a, b) => a.distancia - b.distancia);
            break;
        case 'name-asc':
            result.sort((a, b) => a.nome_emissor.localeCompare(b.nome_emissor));
            break;
    }

    state.filteredData = result;
    state.currentPage = 1;

    renderParityCard();
    renderKpiCards();
    renderMap();
    renderCharts();
    renderTable();
    renderPagination();
}

// 12. Renderização dos Gráficos (Chart.js)
function renderCharts() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#9ca3af' : '#4b5563';
    const gridColor = isDark ? '#2a3449' : '#e5e7eb';

    // Gráfico 1: Evolução Temporal
    const datesSet = new Set();
    const timeSeriesData = {
        'ETANOL': {},
        'GASOLINA COMUM': {},
        'GASOLINA ADITIVADA': {},
        'DIESEL S10': {}
    };

    state.filteredData.forEach(d => {
        if (!d.data_emissao) return;
        const day = d.data_emissao.split('T')[0].split(' ')[0];
        datesSet.add(day);

        if (timeSeriesData[d.desc_produto]) {
            if (!timeSeriesData[d.desc_produto][day]) {
                timeSeriesData[d.desc_produto][day] = [];
            }
            timeSeriesData[d.desc_produto][day].push(d.valor);
        }
    });

    const sortedDates = Array.from(datesSet).sort();
    const formattedLabels = sortedDates.map(dt => {
        const parts = dt.split('-');
        return parts.length === 3 ? `${parts[2]}/${parts[1]}` : dt;
    });

    const datasetsEvolution = [
        {
            label: 'Etanol',
            data: sortedDates.map(d => {
                const vals = timeSeriesData['ETANOL'][d];
                return vals ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
            }),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            tension: 0.3,
            fill: false
        },
        {
            label: 'Gasolina Comum',
            data: sortedDates.map(d => {
                const vals = timeSeriesData['GASOLINA COMUM'][d];
                return vals ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
            }),
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            tension: 0.3,
            fill: false
        },
        {
            label: 'Gasolina Aditivada',
            data: sortedDates.map(d => {
                const vals = timeSeriesData['GASOLINA ADITIVADA'][d];
                return vals ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
            }),
            borderColor: '#ec4899',
            backgroundColor: 'rgba(236, 72, 153, 0.1)',
            tension: 0.3,
            fill: false
        },
        {
            label: 'Diesel S10',
            data: sortedDates.map(d => {
                const vals = timeSeriesData['DIESEL S10'][d];
                return vals ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
            }),
            borderColor: '#06b6d4',
            backgroundColor: 'rgba(6, 182, 212, 0.1)',
            tension: 0.3,
            fill: false
        }
    ];

    const ctxEvol = document.getElementById('priceEvolutionChart').getContext('2d');
    if (state.charts.priceEvolution) {
        state.charts.priceEvolution.destroy();
    }

    state.charts.priceEvolution = new Chart(ctxEvol, {
        type: 'line',
        data: {
            labels: formattedLabels.length > 0 ? formattedLabels : ['Sem dados'],
            datasets: datasetsEvolution
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: textColor } } },
            scales: {
                x: { ticks: { color: textColor }, grid: { color: gridColor } },
                y: { ticks: { color: textColor }, grid: { color: gridColor }, title: { display: true, text: 'Preço Médio (R$)', color: textColor } }
            }
        }
    });

    // Gráfico 2: Paridade
    const parityValues = sortedDates.map(d => {
        const ets = timeSeriesData['ETANOL'][d];
        const gas = timeSeriesData['GASOLINA COMUM'][d];
        if (ets && gas && ets.length > 0 && gas.length > 0) {
            const avgE = ets.reduce((a, b) => a + b, 0) / ets.length;
            const avgG = gas.reduce((a, b) => a + b, 0) / gas.length;
            return ((avgE / avgG) * 100).toFixed(1);
        }
        return null;
    });

    const ctxParity = document.getElementById('parityChart').getContext('2d');
    if (state.charts.parity) {
        state.charts.parity.destroy();
    }

    state.charts.parity = new Chart(ctxParity, {
        type: 'line',
        data: {
            labels: formattedLabels.length > 0 ? formattedLabels : ['Sem dados'],
            datasets: [
                {
                    label: 'Paridade Etanol / Gasolina (%)',
                    data: parityValues,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.15)',
                    fill: true,
                    tension: 0.3
                },
                {
                    label: 'Limite 70% (Vantagem Etanol)',
                    data: sortedDates.map(() => 70),
                    borderColor: '#ef4444',
                    borderDash: [6, 6],
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: textColor } } },
            scales: {
                x: { ticks: { color: textColor }, grid: { color: gridColor } },
                y: { ticks: { color: textColor }, grid: { color: gridColor }, title: { display: true, text: 'Relação (%)', color: textColor }, suggestedMin: 60, suggestedMax: 80 }
            }
        }
    });

    // Gráfico 3: Cidade
    const cityData = {};
    state.filteredData.forEach(d => {
        if (!cityData[d.municipio]) cityData[d.municipio] = [];
        cityData[d.municipio].push(d.valor);
    });

    const cities = Object.keys(cityData);
    const minPrices = cities.map(c => Math.min(...cityData[c]));
    const avgPrices = cities.map(c => (cityData[c].reduce((a, b) => a + b, 0) / cityData[c].length).toFixed(2));

    const ctxComp = document.getElementById('cityComparisonChart').getContext('2d');
    if (state.charts.cityComparison) {
        state.charts.cityComparison.destroy();
    }

    state.charts.cityComparison = new Chart(ctxComp, {
        type: 'bar',
        data: {
            labels: cities,
            datasets: [
                { label: 'Menor Preço (R$)', data: minPrices, backgroundColor: '#10b981', borderRadius: 6 },
                { label: 'Preço Médio (R$)', data: avgPrices, backgroundColor: '#3b82f6', borderRadius: 6 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: textColor } } },
            scales: {
                x: { ticks: { color: textColor }, grid: { color: gridColor } },
                y: { ticks: { color: textColor }, grid: { color: gridColor }, beginAtZero: false }
            }
        }
    });
}

// 13. Renderização da Tabela
function renderTable() {
    const tbody = document.getElementById('tableBody');
    const recordsBadge = document.getElementById('recordsBadge');
    
    recordsBadge.innerText = `Exibindo ${state.filteredData.length} registros`;

    if (state.filteredData.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8">
                    <div class="empty-state">
                        <i class="fa-solid fa-gas-pump"></i>
                        <p>Nenhum preço encontrado para os filtros selecionados.</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    const startIndex = (state.currentPage - 1) * state.itemsPerPage;
    const endIndex = startIndex + state.itemsPerPage;
    const pageItems = state.filteredData.slice(startIndex, endIndex);

    const lowestPrice = Math.min(...state.filteredData.map(d => d.valor));

    tbody.innerHTML = '';
    pageItems.forEach(item => {
        const isLowest = item.valor === lowestPrice;
        const fuelStyle = FUEL_COLORS[item.desc_produto] || { class: 'etanol' };
        
        const dateStr = item.data_emissao ? formatDate(item.data_emissao) : '-';
        const mapsUrl = (item.latitude && item.longitude)
            ? `https://www.google.com/maps/search/?api=1&query=${item.latitude},${item.longitude}`
            : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.nome_emissor + ' ' + item.municipio + ' MT')}`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                ${isLowest ? '<span class="badge-cheapest"><i class="fa-solid fa-star"></i> Menor Preço</span>' : '<span style="color:var(--text-muted);font-size:0.75rem;">—</span>'}
            </td>
            <td>
                <div class="station-cell">
                    <span class="station-title">${item.nome_emissor}</span>
                    <span class="station-id">ID: ${item.id}</span>
                </div>
            </td>
            <td>
                <span class="badge-fuel ${fuelStyle.class}">
                    ${item.desc_produto}
                </span>
            </td>
            <td>
                <div class="price-cell">
                    R$ ${item.valor.toFixed(2)} <small>/L</small>
                </div>
            </td>
            <td>
                <strong>${item.municipio}</strong>
            </td>
            <td>
                ${item.distancia > 0 ? `<i class="fa-solid fa-route"></i> ${item.distancia.toFixed(1)} km` : '-'}
            </td>
            <td>
                <span style="font-size: 0.8rem; color: var(--text-secondary);">
                    ${dateStr}
                </span>
            </td>
            <td>
                <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="btn-map" title="Ver no Google Maps">
                    <i class="fa-solid fa-map-location-dot"></i> Rota
                </a>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// 14. Paginação
function renderPagination() {
    const totalPages = Math.ceil(state.filteredData.length / state.itemsPerPage) || 1;
    const paginationInfo = document.getElementById('paginationInfo');
    const paginationControls = document.getElementById('paginationControls');

    paginationInfo.innerText = `Página ${state.currentPage} de ${totalPages}`;
    paginationControls.innerHTML = '';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn';
    prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
    prevBtn.disabled = state.currentPage === 1;
    prevBtn.addEventListener('click', () => {
        if (state.currentPage > 1) {
            state.currentPage--;
            renderTable();
            renderPagination();
        }
    });
    paginationControls.appendChild(prevBtn);

    const maxVisiblePages = 5;
    let startPage = Math.max(1, state.currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

    if (endPage - startPage < maxVisiblePages - 1) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
        const pageBtn = document.createElement('button');
        pageBtn.className = `page-btn ${i === state.currentPage ? 'active' : ''}`;
        pageBtn.innerText = i;
        pageBtn.addEventListener('click', () => {
            state.currentPage = i;
            renderTable();
            renderPagination();
        });
        paginationControls.appendChild(pageBtn);
    }

    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn';
    nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    nextBtn.disabled = state.currentPage === totalPages;
    nextBtn.addEventListener('click', () => {
        if (state.currentPage < totalPages) {
            state.currentPage++;
            renderTable();
            renderPagination();
        }
    });
    paginationControls.appendChild(nextBtn);
}

// 15. Alternância de Telas (Auth Gate vs Dashboard)
function showLoginView() {
    document.getElementById('authGate').style.display = 'flex';
    document.getElementById('dashboardContent').style.display = 'none';
    document.getElementById('userProfile').style.display = 'none';
    document.getElementById('lastUpdatedText').innerText = 'Aguardando login...';
}

function showDashboardView(user) {
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('dashboardContent').style.display = 'block';
    document.getElementById('userProfile').style.display = 'flex';
    document.getElementById('userEmailText').innerText = user.email || user.displayName || 'Usuário Google';
}

function showAuthAlert(msg, type = 'error') {
    const alertBox = document.getElementById('authAlert');
    const msgSpan = document.getElementById('authAlertMsg');
    msgSpan.innerText = msg;
    alertBox.className = `auth-alert ${type}`;
    alertBox.style.display = 'flex';
}

function hideAuthAlert() {
    document.getElementById('authAlert').style.display = 'none';
}

function setLoginLoading(isLoading) {
    const btn = document.getElementById('loginSubmitBtn');
    const textSpan = document.getElementById('btnSubmitText');
    const spinner = document.getElementById('btnSubmitSpinner');
    btn.disabled = isLoading;
    textSpan.style.display = isLoading ? 'none' : 'inline-flex';
    spinner.style.display = isLoading ? 'inline-block' : 'none';
}

function showEmptyState(msg) {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = `
        <tr>
            <td colspan="8">
                <div class="empty-state">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <p>${msg}</p>
                </div>
            </td>
        </tr>
    `;
}

// 16. Event Listeners
function initEventListeners() {
    // Login com Google
    document.getElementById('btnGoogleLogin').addEventListener('click', handleGoogleLogin);

    // Form de Login com E-mail
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);

    const togglePassBtn = document.getElementById('togglePasswordBtn');
    const passInput = document.getElementById('loginPassword');
    const eyeIcon = document.getElementById('eyeIcon');
    togglePassBtn.addEventListener('click', () => {
        const isPass = passInput.type === 'password';
        passInput.type = isPass ? 'text' : 'password';
        eyeIcon.className = isPass ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    });

    const configToggleBtn = document.getElementById('configToggleBtn');
    const configContent = document.getElementById('configContent');
    configToggleBtn.addEventListener('click', () => {
        const isVisible = configContent.style.display === 'block';
        configContent.style.display = isVisible ? 'none' : 'block';
    });

    document.getElementById('saveConfigBtn').addEventListener('click', () => {
        const apiKey = document.getElementById('cfgApiKey').value.trim();
        const projectId = document.getElementById('cfgProjectId').value.trim();
        const authDomain = document.getElementById('cfgAuthDomain').value.trim();

        if (!apiKey || !projectId) {
            alert('Por favor, preencha a API Key e o Project ID.');
            return;
        }

        localStorage.setItem('firebase_api_key', apiKey);
        localStorage.setItem('firebase_project_id', projectId);
        if (authDomain) localStorage.setItem('firebase_auth_domain', authDomain);

        alert('Chaves do Firebase salvas no seu navegador!');
        configContent.style.display = 'none';
        initFirebase();
    });

    document.getElementById('btnRecenterMap').addEventListener('click', () => {
        if (state.map && state.markersGroup) {
            const layers = state.markersGroup.getLayers();
            if (layers.length > 0) {
                const group = L.featureGroup(layers);
                state.map.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 14 });
            } else {
                state.map.setView(DEFAULT_MT_CENTER, 12);
            }
        }
    });

    const pills = document.querySelectorAll('#fuelPills .pill-btn');
    pills.forEach(pill => {
        pill.addEventListener('click', () => {
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            state.currentFuel = pill.getAttribute('data-fuel');
            applyFilters();
        });
    });

    document.getElementById('citySelect').addEventListener('change', (e) => {
        state.currentCity = e.target.value;
        applyFilters();
    });

    document.getElementById('sortSelect').addEventListener('change', (e) => {
        state.currentSort = e.target.value;
        applyFilters();
    });

    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    let debounceTimeout;
    searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        clearSearchBtn.style.display = val ? 'block' : 'none';
        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => {
            state.searchQuery = val;
            applyFilters();
        }, 300);
    });

    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearSearchBtn.style.display = 'none';
        state.searchQuery = '';
        applyFilters();
    });

    document.getElementById('resetFiltersBtn').addEventListener('click', () => {
        state.currentFuel = 'ALL';
        state.currentCity = 'ALL';
        state.searchQuery = '';
        state.currentSort = 'price-asc';

        pills.forEach(p => p.classList.toggle('active', p.getAttribute('data-fuel') === 'ALL'));
        document.getElementById('citySelect').value = 'ALL';
        document.getElementById('sortSelect').value = 'price-asc';
        searchInput.value = '';
        clearSearchBtn.style.display = 'none';

        applyFilters();
    });

    document.getElementById('btnRefreshData').addEventListener('click', loadDataFromFirestore);
    document.getElementById('btnExportCSV').addEventListener('click', exportToCSV);
    document.getElementById('btnExportJSON').addEventListener('click', exportToJSON);
    document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);
}

// 17. Funções Utilitárias & Exportação
function formatDate(dateStr) {
    try {
        const dt = new Date(dateStr);
        return dt.toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch {
        return dateStr;
    }
}

function exportToCSV() {
    if (state.filteredData.length === 0) return;

    const headers = ['ID', 'Posto', 'Combustivel', 'Preco', 'Municipio', 'Distancia_KM', 'Data_Emissao'];
    const rows = state.filteredData.map(item => [
        `"${item.id}"`,
        `"${(item.nome_emissor || '').replace(/"/g, '""')}"`,
        `"${item.desc_produto}"`,
        item.valor,
        `"${item.municipio}"`,
        item.distancia,
        `"${item.data_emissao}"`
    ]);

    const csvContent = "data:text/csv;charset=utf-8," + 
        [headers.join(','), ...rows.map(e => e.join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `menor_preco_mt_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportToJSON() {
    if (state.filteredData.length === 0) return;

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.filteredData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `menor_preco_mt_${new Date().toISOString().slice(0,10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

function initTheme() {
    const savedTheme = localStorage.getItem('app-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('app-theme', newTheme);
    updateThemeIcon(newTheme);
    renderCharts();
}

function updateThemeIcon(theme) {
    const icon = document.getElementById('themeIcon');
    if (theme === 'dark') {
        icon.className = 'fa-solid fa-moon';
    } else {
        icon.className = 'fa-solid fa-sun';
    }
}
