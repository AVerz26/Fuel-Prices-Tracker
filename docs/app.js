/**
 * Monitor de Combustíveis MT - Clean & Fast Analytics
 * Leaflet com destaque do Estado de Mato Grosso + Firebase Firestore + Análise de Paridade
 */

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
    itemsPerPage: 12,
    map: null,
    markersGroup: null,
    mtBoundaryLayer: null,
    mtBounds: null,
    charts: {
        priceEvolution: null,
        parity: null,
        cityComparison: null
    }
};

const FUEL_CONFIG = {
    'ETANOL': { class: 'fuel-etanol', label: 'Etanol' },
    'GASOLINA': { class: 'fuel-gasolina', label: 'Gasolina' },
    'GASOLINA ADITIVADA': { class: 'fuel-gasolina-aditivada', label: 'Gasolina Aditivada' },
    'DIESEL S10': { class: 'fuel-diesel-s10', label: 'Diesel S10' },
    'DIESEL S500': { class: 'fuel-diesel-s500', label: 'Diesel S500' }
};

// Bounding box padrão de Mato Grosso
const MT_DEFAULT_BOUNDS = [
    [-18.04, -61.63], // Sudoeste
    [-7.35, -50.22]   // Nordeste
];

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initEventListeners();
    initFirebase();
});

// ==========================================================
// 1. Firebase Initialization & Auth
// ==========================================================
function initFirebase() {
    const savedApiKey = localStorage.getItem('firebase_api_key') || (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey);
    const savedProjectId = localStorage.getItem('firebase_project_id') || (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId);
    const savedAuthDomain = localStorage.getItem('firebase_auth_domain') || (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.authDomain);

    if (savedApiKey) document.getElementById('cfgApiKey').value = savedApiKey;
    if (savedProjectId) document.getElementById('cfgProjectId').value = savedProjectId;

    if (!savedApiKey || !savedProjectId) {
        showAuthAlert('Chaves do Firebase não configuradas.', 'warning');
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
        // Habilita persistência de cache local no navegador (IndexedDB)
        state.db.enablePersistence({ synchronizeTabs: true }).catch(err => {
            console.warn('Persistência Firestore:', err.code);
        });

        firebase.auth().onAuthStateChanged(async user => {
            if (user) {
                state.currentUser = user;
                await verifyUserAccessAndRole(user);
            } else {
                state.currentUser = null;
                showAuth();
            }
        });
    } catch (err) {
        console.error('Erro Firebase:', err);
        showAuthAlert('Erro ao inicializar Firebase. Verifique a configuração.');
    }
}

// ==========================================================
// Controle de Acesso e Aprovação de Usuários
// ==========================================================
async function verifyUserAccessAndRole(user) {
    try {
        const userRef = state.db.collection('usuarios').doc(user.uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            // Se for o primeiro usuário ou login direto do administrador, cadastra como APROVADO / ADMIN
            await userRef.set({
                uid: user.uid,
                email: user.email,
                nome: user.displayName || user.email.split('@')[0],
                status: 'APROVADO',
                role: 'ADMIN',
                criado_em: firebase.firestore.FieldValue.serverTimestamp()
            });
            showDashboard(user);
            setupAdminPanel();
            loadDataFromFirestore();
            return;
        }

        const data = userDoc.data();
        if (data.status === 'PENDENTE') {
            showPendingGate();
            return;
        }

        // Usuário Aprovado
        showDashboard(user);
        if (data.role === 'ADMIN' || data.email === user.email) {
            setupAdminPanel();
        }
        loadDataFromFirestore();
    } catch (e) {
        console.warn('Verificação de usuário:', e);
        showDashboard(user);
        loadDataFromFirestore();
    }
}

async function handleRegister(e) {
    e.preventDefault();
    hideAuthAlert();

    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirmPassword = document.getElementById('regConfirmPassword').value;

    if (password !== confirmPassword) {
        showAuthAlert('As senhas não coincidem.');
        return;
    }

    if (!state.firebaseApp) return showAuthAlert('Configure o Firebase primeiro.');
    setRegisterLoading(true);

    try {
        const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
        const newUser = cred.user;

        // Grava no Firestore com status PENDENTE para aprovação do administrador
        await state.db.collection('usuarios').doc(newUser.uid).set({
            uid: newUser.uid,
            nome: name,
            email: email,
            status: 'PENDENTE',
            role: 'USER',
            criado_em: firebase.firestore.FieldValue.serverTimestamp()
        });

        // Desloga e mostra tela de aprovação pendente
        await firebase.auth().signOut();
        showPendingGate();
    } catch (err) {
        console.error('Erro no registro:', err);
        showAuthAlert(err.message || 'Erro ao registrar conta.');
    } finally {
        setRegisterLoading(false);
    }
}

function setupAdminPanel() {
    const adminBtn = document.getElementById('btnAdminUsers');
    if (adminBtn) adminBtn.style.display = 'inline-flex';

    // Ouve em tempo real solicitações pendentes
    state.db.collection('usuarios').where('status', '==', 'PENDENTE').onSnapshot(snap => {
        const count = snap.size;
        document.getElementById('adminPendingCount').innerText = count > 0 ? `Aprovações (${count})` : 'Aprovações';
        renderAdminUsersList(snap.docs);
    });
}

function renderAdminUsersList(docs) {
    const list = document.getElementById('adminUsersList');
    const loading = document.getElementById('adminUsersLoading');
    loading.style.display = 'none';

    if (!docs || docs.length === 0) {
        list.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted)">Nenhuma solicitação pendente no momento.</div>`;
        return;
    }

    list.innerHTML = '';
    docs.forEach(doc => {
        const u = doc.data();
        const card = document.createElement('div');
        card.className = 'user-item-card';
        card.innerHTML = `
            <div class="user-item-info">
                <span class="user-item-name">${u.nome || 'Novo Usuário'}</span>
                <span class="user-item-email">${u.email}</span>
            </div>
            <div class="user-item-actions">
                <button class="btn-approve" onclick="approveUser('${u.uid}')"><i class="fa-solid fa-check"></i> Aprovar</button>
                <button class="btn-reject" onclick="rejectUser('${u.uid}')"><i class="fa-solid fa-xmark"></i> Recusar</button>
            </div>
        `;
        list.appendChild(card);
    });
}

window.approveUser = async function(uid) {
    try {
        await state.db.collection('usuarios').doc(uid).update({
            status: 'APROVADO',
            aprovado_em: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) {
        alert('Erro ao aprovar: ' + e.message);
    }
};

window.rejectUser = async function(uid) {
    if (confirm('Deseja realmente recusar o acesso deste usuário?')) {
        try {
            await state.db.collection('usuarios').doc(uid).delete();
        } catch (e) {
            alert('Erro ao recusar: ' + e.message);
        }
    }
};

async function handleGoogleLogin() {
    hideAuthAlert();
    if (!state.firebaseApp) return showAuthAlert('Configure o Firebase antes de prosseguir.');
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        await firebase.auth().signInWithPopup(provider);
    } catch (err) {
        console.error('Login Google:', err);
        showAuthAlert(err.message || 'Falha ao autenticar com o Google.');
    }
}

async function handleEmailLogin(e) {
    e.preventDefault();
    hideAuthAlert();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!state.firebaseApp) return showAuthAlert('Configure o Firebase primeiro.');
    setLoginLoading(true);

    try {
        await firebase.auth().signInWithEmailAndPassword(email, password);
    } catch (err) {
        console.error('Login Email:', err);
        showAuthAlert('E-mail ou senha inválidos.');
    } finally {
        setLoginLoading(false);
    }
}

async function handleLogout() {
    if (state.firebaseApp) await firebase.auth().signOut();
    state.currentUser = null;
    showAuth();
}

function showPendingGate() {
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('dashboardContent').style.display = 'none';
    document.getElementById('userSession').style.display = 'none';
    document.getElementById('pendingApprovalGate').style.display = 'flex';
    document.getElementById('syncStatusText').innerText = 'Aprovação pendente';
}

function setRegisterLoading(isLoading) {
    document.getElementById('registerSubmitBtn').disabled = isLoading;
    document.getElementById('btnRegText').style.display = isLoading ? 'none' : 'inline';
    document.getElementById('btnRegSpinner').style.display = isLoading ? 'inline-block' : 'none';
}

// Limites realistas de preços de combustíveis (Elimina erros e outliers da SEFAZ)
const REALISTIC_PRICE_BOUNDS = {
    'ETANOL': { min: 2.20, max: 6.50 },
    'GASOLINA': { min: 3.80, max: 8.50 },
    'GASOLINA ADITIVADA': { min: 3.80, max: 9.20 },
    'DIESEL S10': { min: 4.20, max: 8.90 },
    'DIESEL S500': { min: 4.00, max: 8.50 }
};

function isValidPrice(fuel, price) {
    if (!price || isNaN(price) || price <= 0) return false;
    const bounds = REALISTIC_PRICE_BOUNDS[fuel];
    if (bounds) {
        return price >= bounds.min && price <= bounds.max;
    }
    return price >= 2.00 && price <= 10.00;
}

// ==========================================================
// 2. Data Fetching (Dataset Histórico Completo 354k + Live Firestore)
// ==========================================================
async function loadDataFromFirestore() {
    const statusText = document.getElementById('syncStatusText');
    statusText.innerText = 'Carregando base completa de Mato Grosso...';

    // 1. Carrega o dataset consolidado completo com 100% do histórico
    try {
        const res = await fetch('data/historico_completo.json');
        if (res.ok) {
            const hist = await res.json();
            if (hist && hist.postos) {
                state.allData = hist.postos;
                state.timelineData = hist.timeline || {};
                populateCityFilter(state.allData);
                applyFilters();
                statusText.innerText = `Base MT: ${hist.total_registros_validos.toLocaleString('pt-BR')} registros (${hist.dias_historico} dias)`;
            }
        }
    } catch (e) {
        console.warn('Carregamento de histórico JSON:', e);
    }

    // 2. Consulta incremental ao Firestore para puxar dados em tempo real
    if (state.db) {
        try {
            const query = state.db.collection('precos').orderBy('data_emissao', 'desc').limit(500);
            const snapshot = await query.get();
            const liveDocs = [];

            snapshot.forEach(doc => {
                const d = doc.data();
                let prod = (d.desc_produto || '').toUpperCase().trim();
                if (prod === 'GASOLINA COMUM') prod = 'GASOLINA';
                const val = parseFloat(d.valor_unidade_comercial || d.valor || 0);

                if (!isValidPrice(prod, val)) return;

                liveDocs.push({
                    id: d.id || doc.id,
                    nome_emissor: d.nome_emissor || '',
                    desc_produto: prod,
                    valor: val,
                    municipio: (d.nome_municipio_emissor || d.municipio || '').toUpperCase().trim(),
                    latitude: d.latitude ? parseFloat(d.latitude) : null,
                    longitude: d.longitude ? parseFloat(d.longitude) : null,
                    distancia: d.distancia ? parseFloat(d.distancia) : 0.0,
                    data_emissao: d.data_emissao || ''
                });
            });

            if (liveDocs.length > 0) {
                const idSet = new Set(liveDocs.map(d => d.id));
                const combined = [...liveDocs, ...state.allData.filter(d => !idSet.has(d.id))];
                combined.sort((a, b) => new Date(b.data_emissao) - new Date(a.data_emissao));
                state.allData = combined;

                populateCityFilter(state.allData);
                applyFilters();
                const dt = new Date(combined[0].data_emissao);
                statusText.innerText = `Sincronizado: ${dt.toLocaleDateString('pt-BR')} ${dt.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}`;
            }
        } catch (err) {
            console.warn('Sync Firestore incremental:', err);
        }
    }
}

function populateCityFilter(data) {
    const select = document.getElementById('citySelect');
    const cities = [...new Set(data.map(d => d.municipio))].filter(Boolean).sort();

    select.innerHTML = '<option value="ALL">Todo o Estado (MT)</option>';
    cities.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        select.appendChild(opt);
    });
}

// Coordenadas padrão dos polos de MT
const CITY_COORDS = {
    "PRIMAVERA DO LESTE": [-15.552, -54.283],
    "VARZEA GRANDE": [-15.631, -56.177],
    "CUIABA": [-15.600, -56.096],
    "BARRA DO GARCAS": [-15.891, -52.261],
    "SORRISO": [-12.546, -55.726],
    "CONFRESA": [-10.657, -51.570],
    "BRASNORTE": [-12.125, -58.006],
    "RONDONOPOLIS": [-16.467, -54.636],
    "SINOP": [-11.860, -55.509]
};

// ==========================================================
// 3. Map with State of Mato Grosso Highlight (Leaflet)
// ==========================================================
function initMap() {
    if (state.map) return;

    // Inicializa o mapa focado em MT
    state.map = L.map('map', {
        zoomControl: true,
        scrollWheelZoom: true
    }).fitBounds(MT_DEFAULT_BOUNDS);

    // OpenStreetMap 100% livre e gratuito (NÃO requer API Key)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(state.map);

    state.markersGroup = L.layerGroup().addTo(state.map);

    // Carrega o polígono oficial da malha de Mato Grosso (IBGE UF 51)
    loadMatoGrossoBoundary();
}

async function loadMatoGrossoBoundary() {
    try {
        // API Oficial do IBGE para o contorno do Estado de MT
        const res = await fetch('https://servicodados.ibge.gov.br/api/v3/malhas/estados/51?formato=application/vnd.geo+json');
        if (res.ok) {
            const geojson = await res.json();
            
            if (state.mtBoundaryLayer) {
                state.map.removeLayer(state.mtBoundaryLayer);
            }

            state.mtBoundaryLayer = L.geoJSON(geojson, {
                style: {
                    color: '#2563eb',       // Linha de contorno do Estado
                    weight: 2.5,
                    opacity: 0.85,
                    dashArray: '4, 4',
                    fillColor: '#2563eb',
                    fillOpacity: 0.04
                }
            }).addTo(state.map);

            state.mtBounds = state.mtBoundaryLayer.getBounds();
        }
    } catch (e) {
        console.warn('Usando contorno padrão de MT:', e);
    }
}

function getLatestDate(data) {
    if (!data || data.length === 0) return null;
    let latest = null;
    for (const d of data) {
        if (d.data_emissao) {
            const day = d.data_emissao.split('T')[0].split(' ')[0];
            if (!latest || day > latest) {
                latest = day;
            }
        }
    }
    return latest;
}

function formatDateOnly(str) {
    if (!str) return '';
    const p = str.split('T')[0].split(' ')[0].split('-');
    return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : str;
}

function renderMap() {
    initMap();
    state.markersGroup.clearLayers();

    const valid = state.filteredData.filter(d => d.latitude && d.longitude && !isNaN(d.latitude) && !isNaN(d.longitude));
    
    // Identifica a data mais recente dos postos filtrados
    const latestDay = getLatestDate(valid);

    // Filtra apenas postos da data mais recente (com fallback para leitura mais recente de cada posto)
    let recentValid = valid;
    if (latestDay) {
        const exactDayValid = valid.filter(d => (d.data_emissao || '').startsWith(latestDay));
        if (exactDayValid.length > 0) {
            recentValid = exactDayValid;
        }
    }

    // Deduplica postos no mapa: 1 marcador por posto físico
    const uniqueMap = new Map();
    recentValid.forEach(item => {
        const key = `${item.nome_emissor}_${item.latitude.toFixed(4)}_${item.longitude.toFixed(4)}_${item.desc_produto}`;
        if (!uniqueMap.has(key)) {
            uniqueMap.set(key, item);
        }
    });

    const displayStations = Array.from(uniqueMap.values());
    const dateTag = latestDay ? ` &bull; ${formatDateOnly(latestDay)}` : '';
    document.getElementById('mapPostosCount').innerHTML = `${displayStations.length} postos mapeados${dateTag}`;

    if (displayStations.length === 0) {
        if (state.mtBounds) state.map.fitBounds(state.mtBounds);
        return;
    }

    const prices = displayStations.map(d => d.valor).sort((a, b) => a - b);
    const p25 = prices[Math.floor(prices.length * 0.25)] || prices[0];
    const p75 = prices[Math.floor(prices.length * 0.75)] || prices[prices.length - 1];

    const bounds = L.latLngBounds();

    displayStations.forEach(item => {
        let tagClass = 'tag-medium';
        if (item.valor <= p25) {
            tagClass = 'tag-cheapest';
        } else if (item.valor >= p75) {
            tagClass = 'tag-expensive';
        }

        // Marcador em formato de tag de preço direto no mapa (R$ 4,19)
        const markerHtml = `<div class="price-marker-tag ${tagClass}">R$ ${item.valor.toFixed(2)}</div>`;
        const customIcon = L.divIcon({
            html: markerHtml,
            className: 'clean-map-icon',
            iconSize: [60, 24],
            iconAnchor: [30, 12],
            popupAnchor: [0, -14]
        });

        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${item.latitude},${item.longitude}`;
        const popupHtml = `
            <div class="popup-content">
                <div class="popup-title">${item.nome_emissor}</div>
                <div class="popup-val">R$ ${item.valor.toFixed(2)} <span style="font-size:0.7rem;color:var(--text-muted)">/L</span></div>
                <div class="popup-meta">
                    <span><strong>Combustível:</strong> ${item.desc_produto}</span>
                    <span><strong>Município:</strong> ${item.municipio}</span>
                    ${item.distancia > 0 ? `<span><strong>Distância:</strong> ${item.distancia.toFixed(1)} km</span>` : ''}
                    <span><strong>NF:</strong> ${formatDate(item.data_emissao)}</span>
                </div>
                <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="popup-route">
                    <i class="fa-solid fa-diamond-turn-right"></i> Traçar Rota no Google Maps
                </a>
            </div>
        `;

        const marker = L.marker([item.latitude, item.longitude], { icon: customIcon })
            .bindPopup(popupHtml);

        state.markersGroup.addLayer(marker);
        bounds.extend([item.latitude, item.longitude]);
    });

    if (state.currentCity !== 'ALL') {
        if (bounds.isValid()) {
            state.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
        } else if (CITY_COORDS[state.currentCity]) {
            state.map.setView(CITY_COORDS[state.currentCity], 13);
        }
    } else {
        if (state.mtBounds) {
            state.map.fitBounds(state.mtBounds, { padding: [20, 20] });
        } else if (bounds.isValid()) {
            state.map.fitBounds(bounds, { padding: [30, 30] });
        }
    }

    setTimeout(() => {
        if (state.map) state.map.invalidateSize();
    }, 150);
}

// ==========================================================
// 4. Filtering & Calculations
// ==========================================================
function applyFilters() {
    let list = [...state.allData];

    if (state.currentFuel !== 'ALL') {
        list = list.filter(d => d.desc_produto === state.currentFuel);
    }

    if (state.currentCity !== 'ALL') {
        list = list.filter(d => d.municipio === state.currentCity);
    }

    if (state.searchQuery.trim() !== '') {
        const q = state.searchQuery.toLowerCase().trim();
        list = list.filter(d => 
            d.nome_emissor.toLowerCase().includes(q) ||
            d.municipio.toLowerCase().includes(q) ||
            d.desc_produto.toLowerCase().includes(q)
        );
    }

    switch (state.currentSort) {
        case 'price-asc': list.sort((a, b) => a.valor - b.valor); break;
        case 'price-desc': list.sort((a, b) => b.valor - a.valor); break;
        case 'date-desc': list.sort((a, b) => new Date(b.data_emissao) - new Date(a.data_emissao)); break;
        case 'distance-asc': list.sort((a, b) => a.distancia - b.distancia); break;
    }

    state.filteredData = list;
    state.currentPage = 1;

    renderKPIs();
    renderParity();
    renderMap();
    renderCharts();
}

function renderKPIs() {
    const fuels = [
        { key: 'ETANOL', valId: 'kpiEtanolPrice', stId: 'kpiEtanolStation' },
        { key: 'GASOLINA', valId: 'kpiGasolinaPrice', stId: 'kpiGasolinaStation' },
        { key: 'GASOLINA ADITIVADA', valId: 'kpiAditivadaPrice', stId: 'kpiAditivadaStation' },
        { key: 'DIESEL S10', valId: 'kpiDieselPrice', stId: 'kpiDieselStation' }
    ];

    const baseData = state.currentCity === 'ALL' ? state.allData : state.allData.filter(d => d.municipio === state.currentCity);
    
    // Identifica estritamente a data mais recente
    const latestDay = getLatestDate(baseData);
    let recentData = baseData;
    if (latestDay) {
        const exactDayData = baseData.filter(d => (d.data_emissao || '').startsWith(latestDay));
        if (exactDayData.length > 0) recentData = exactDayData;
    }

    fuels.forEach(f => {
        let items = recentData.filter(d => d.desc_produto === f.key);
        if (items.length === 0) {
            // Se o combustível não tiver emissão exata naquele dia, pega a leitura mais recente dele
            items = baseData.filter(d => d.desc_produto === f.key);
        }

        const valElem = document.getElementById(f.valId);
        const stElem = document.getElementById(f.stId);

        if (items.length > 0) {
            const min = items.reduce((a, b) => a.valor < b.valor ? a : b);
            valElem.innerText = `R$ ${min.valor.toFixed(2)}`;
            stElem.innerText = `${min.nome_emissor} (${min.municipio})`;
        } else {
            valElem.innerText = 'R$ --';
            stElem.innerText = 'Sem dados recentes';
        }
    });
}

function renderParity() {
    const baseData = state.currentCity === 'ALL' ? state.allData : state.allData.filter(d => d.municipio === state.currentCity);
    const latestDay = getLatestDate(baseData);
    
    let recentData = baseData;
    if (latestDay) {
        const exactDayData = baseData.filter(d => (d.data_emissao || '').startsWith(latestDay));
        if (exactDayData.length > 0) recentData = exactDayData;
    }

    let etanol = recentData.filter(d => d.desc_produto === 'ETANOL');
    let gasolina = recentData.filter(d => d.desc_produto === 'GASOLINA');

    if (etanol.length === 0) etanol = baseData.filter(d => d.desc_produto === 'ETANOL');
    if (gasolina.length === 0) gasolina = baseData.filter(d => d.desc_produto === 'GASOLINA');

    const ratioElem = document.getElementById('parityRatioValue');
    const verdictElem = document.getElementById('parityVerdict');
    const descElem = document.getElementById('parityDesc');

    if (etanol.length > 0 && gasolina.length > 0) {
        const avgE = etanol.reduce((s, i) => s + i.valor, 0) / etanol.length;
        const avgG = gasolina.reduce((s, i) => s + i.valor, 0) / gasolina.length;
        const ratio = (avgE / avgG) * 100;

        ratioElem.innerText = `${ratio.toFixed(1)}%`;

        if (ratio <= 70) {
            const eco = (70 - ratio).toFixed(1);
            verdictElem.className = 'parity-verdict verdict-etanol';
            verdictElem.innerText = 'Vantagem ETANOL';
            descElem.innerText = `Etanol (R$ ${avgE.toFixed(2)}) abaixo do teto de 70% da Gasolina (R$ ${avgG.toFixed(2)}). Economia de ~${eco}%.`;
        } else {
            verdictElem.className = 'parity-verdict verdict-gasolina';
            verdictElem.innerText = 'Vantagem GASOLINA';
            descElem.innerText = `Etanol (R$ ${avgE.toFixed(2)}) atingiu ${ratio.toFixed(1)}% da Gasolina. Gasolina é mais vantajosa.`;
        }
    } else {
        ratioElem.innerText = '--%';
        verdictElem.className = 'parity-verdict';
        verdictElem.innerText = 'Sem dados';
        descElem.innerText = 'Necessita de dados de Etanol e Gasolina.';
    }
}

// ==========================================================
// 5. Chart.js Visualizations (Com Análise 7D, 1M, 6M, 1A e Média Móvel)
// ==========================================================
function renderCharts() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#94a3b8' : '#475569';
    const gridColor = isDark ? '#1e293b' : '#e2e8f0';

    // 1. Mapeamento de dados por data (100% da base histórica consolidada + tempo real)
    const datesMap = {};
    let latestTimestamp = 0;
    let earliestTimestamp = Infinity;

    // Incorpora histórico global consolidado de todas as datas
    if (state.currentCity === 'ALL' && state.timelineData) {
        Object.entries(state.timelineData).forEach(([day, fuels]) => {
            const ts = new Date(day).getTime();
            if (!isNaN(ts)) {
                if (ts > latestTimestamp) latestTimestamp = ts;
                if (ts < earliestTimestamp) earliestTimestamp = ts;
                if (!datesMap[day]) datesMap[day] = {};
                Object.entries(fuels).forEach(([fuel, stats]) => {
                    if (!datesMap[day][fuel]) datesMap[day][fuel] = [];
                    if (stats && stats.media) datesMap[day][fuel].push(stats.media);
                });
            }
        });
    }

    state.filteredData.forEach(d => {
        if (!d.data_emissao) return;
        const day = d.data_emissao.split('T')[0].split(' ')[0];
        const ts = new Date(day).getTime();
        if (ts > latestTimestamp) latestTimestamp = ts;
        if (ts < earliestTimestamp) earliestTimestamp = ts;

        if (!datesMap[day]) datesMap[day] = {};
        if (!datesMap[day][d.desc_produto]) datesMap[day][d.desc_produto] = [];
        datesMap[day][d.desc_produto].push(d.valor);
    });

    const maxDateStr = latestTimestamp > 0 ? new Date(latestTimestamp).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

    // 2. Determina a quantidade de dias para a série contínua
    let daysCount = 30; // Padrão 1M
    const period = state.chartPeriod || '1M';
    if (period === '7D') daysCount = 7;
    else if (period === '1M') daysCount = 30;
    else if (period === '6M') daysCount = 180;
    else if (period === '1A') daysCount = 365;
    else if (period === 'ALL') {
        const diffDays = Math.ceil((latestTimestamp - earliestTimestamp) / (1000 * 60 * 60 * 24)) + 1;
        daysCount = Math.max(diffDays, 7);
    }

    // 3. Gera linha do tempo contínua (dia a dia)
    const continuousDates = [];
    const maxDateObj = new Date(maxDateStr);
    for (let i = daysCount - 1; i >= 0; i--) {
        const dt = new Date(maxDateObj);
        dt.setDate(dt.getDate() - i);
        continuousDates.push(dt.toISOString().slice(0, 10));
    }

    const dayLabels = continuousDates.map(day => {
        const p = day.split('-');
        return p.length === 3 ? `${p[2]}/${p[1]}` : day;
    });

    // 4. Média Móvel para suavizar e preencher dados faltantes
    const etanolSeries = calculateMovingAverageSeries(continuousDates, datesMap, 'ETANOL', 5);
    const gasolinaSeries = calculateMovingAverageSeries(continuousDates, datesMap, 'GASOLINA', 5);
    const aditivadaSeries = calculateMovingAverageSeries(continuousDates, datesMap, 'GASOLINA ADITIVADA', 5);
    const dieselSeries = calculateMovingAverageSeries(continuousDates, datesMap, 'DIESEL S10', 5);

    // Gráfico 1: Evolução Temporal com Média Móvel
    const ctxEvol = document.getElementById('priceEvolutionChart').getContext('2d');
    if (state.charts.priceEvolution) state.charts.priceEvolution.destroy();

    state.charts.priceEvolution = new Chart(ctxEvol, {
        type: 'line',
        data: {
            labels: dayLabels,
            datasets: [
                {
                    label: 'Etanol',
                    data: etanolSeries,
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.08)',
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: daysCount <= 30 ? 3 : 0,
                    pointHoverRadius: 5
                },
                {
                    label: 'Gasolina',
                    data: gasolinaSeries,
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.08)',
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: daysCount <= 30 ? 3 : 0,
                    pointHoverRadius: 5
                },
                {
                    label: 'Gasolina Aditivada',
                    data: aditivadaSeries,
                    borderColor: '#ec4899',
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: daysCount <= 30 ? 3 : 0,
                    pointHoverRadius: 5
                },
                {
                    label: 'Diesel S10',
                    data: dieselSeries,
                    borderColor: '#0ea5e9',
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: daysCount <= 30 ? 3 : 0,
                    pointHoverRadius: 5
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { 
                legend: { labels: { color: textColor, boxWidth: 12, font: { family: 'Inter', size: 11 } } },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: R$ ${parseFloat(context.raw).toFixed(2)}`;
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { color: textColor, maxTicksLimit: 10, font: { family: 'Inter', size: 10 } }, grid: { color: gridColor } },
                y: { 
                    ticks: { 
                        color: textColor,
                        callback: val => `R$ ${val.toFixed(2)}`,
                        font: { family: 'Inter', size: 10 }
                    }, 
                    grid: { color: gridColor } 
                }
            }
        }
    });

    // Gráfico 2: Paridade Etanol/Gasolina com Média Móvel
    const parityVals = continuousDates.map((_, idx) => {
        const e = etanolSeries[idx];
        const g = gasolinaSeries[idx];
        return (e && g && g > 0) ? parseFloat(((e / g) * 100).toFixed(1)) : null;
    });

    const ctxPar = document.getElementById('parityChart').getContext('2d');
    if (state.charts.parity) state.charts.parity.destroy();

    state.charts.parity = new Chart(ctxPar, {
        type: 'line',
        data: {
            labels: dayLabels,
            datasets: [
                {
                    label: 'Paridade (%)',
                    data: parityVals,
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.1)',
                    fill: true,
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: daysCount <= 30 ? 3 : 0
                },
                {
                    label: 'Teto 70% (Vantagem Etanol)',
                    data: continuousDates.map(() => 70),
                    borderColor: '#ef4444',
                    borderDash: [5, 5],
                    borderWidth: 1.5,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { 
                legend: { labels: { color: textColor, boxWidth: 12, font: { family: 'Inter', size: 11 } } },
                tooltip: {
                    callbacks: {
                        label: context => `${context.dataset.label}: ${context.raw}%`
                    }
                }
            },
            scales: {
                x: { ticks: { color: textColor, maxTicksLimit: 8, font: { family: 'Inter', size: 10 } }, grid: { color: gridColor } },
                y: { 
                    ticks: { color: textColor, callback: val => `${val}%`, font: { family: 'Inter', size: 10 } }, 
                    grid: { color: gridColor }, 
                    suggestedMin: 60, 
                    suggestedMax: 80 
                }
            }
        }
    });

    // Gráfico 3: Comparativo por Cidade
    const cityMap = {};
    state.filteredData.forEach(d => {
        if (!cityMap[d.municipio]) cityMap[d.municipio] = [];
        cityMap[d.municipio].push(d.valor);
    });

    const cities = Object.keys(cityMap);
    const minPrices = cities.map(c => Math.min(...cityMap[c]));
    const avgPrices = cities.map(c => parseFloat((cityMap[c].reduce((a, b) => a + b, 0) / cityMap[c].length).toFixed(2)));

    const ctxCity = document.getElementById('cityComparisonChart').getContext('2d');
    if (state.charts.cityComparison) state.charts.cityComparison.destroy();

    state.charts.cityComparison = new Chart(ctxCity, {
        type: 'bar',
        data: {
            labels: cities,
            datasets: [
                { label: 'Menor Preço (R$)', data: minPrices, backgroundColor: '#10b981', borderRadius: 4 },
                { label: 'Média (R$)', data: avgPrices, backgroundColor: '#2563eb', borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: textColor, boxWidth: 12, font: { family: 'Inter', size: 11 } } } },
            scales: {
                x: { ticks: { color: textColor, font: { family: 'Inter', size: 10 } }, grid: { color: gridColor } },
                y: { ticks: { color: textColor, callback: val => `R$ ${val.toFixed(2)}`, font: { family: 'Inter', size: 10 } }, grid: { color: gridColor } }
            }
        }
    });
}

function filterOutliersIQR(values) {
    if (!values || values.length < 4) return values;
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    if (iqr === 0) return values;
    const minVal = q1 - 1.5 * iqr;
    const maxVal = q3 + 1.5 * iqr;
    const filtered = values.filter(v => v >= minVal && v <= maxVal);
    return filtered.length > 0 ? filtered : values;
}

// Função de Média Móvel com interpolação contínua e remoção de outliers
function calculateMovingAverageSeries(continuousDates, rawDateMap, fuelKey, windowSize = 5) {
    const rawValues = continuousDates.map(d => {
        let vals = rawDateMap[d] && rawDateMap[d][fuelKey];
        if (vals && vals.length > 0) {
            // Remove outliers estatísticos (discrepâncias pontuais da SEFAZ)
            vals = filterOutliersIQR(vals);
            return vals.reduce((a, b) => a + b, 0) / vals.length;
        }
        return null;
    });

    const result = [];
    let lastValid = null;

    // Preenche primeiro com a média dos primeiros valores conhecidos se o início for nulo
    const firstKnown = rawValues.find(v => v !== null);
    if (firstKnown !== undefined) lastValid = firstKnown;

    for (let i = 0; i < rawValues.length; i++) {
        if (rawValues[i] !== null) {
            result.push(parseFloat(rawValues[i].toFixed(2)));
            lastValid = rawValues[i];
        } else {
            // Média móvel da janela dos vizinhos mais próximos
            const windowValues = [];
            const start = Math.max(0, i - windowSize);
            const end = Math.min(rawValues.length, i + windowSize + 1);
            for (let j = start; j < end; j++) {
                if (rawValues[j] !== null) windowValues.push(rawValues[j]);
            }

            if (windowValues.length > 0) {
                const avg = windowValues.reduce((a, b) => a + b, 0) / windowValues.length;
                result.push(parseFloat(avg.toFixed(2)));
                lastValid = avg;
            } else if (lastValid !== null) {
                result.push(parseFloat(lastValid.toFixed(2)));
            } else {
                result.push(null);
            }
        }
    }

    return result;
}

// ==========================================================
// 6. Data Table & Pagination
// ==========================================================
function initEventListeners() {
    // Abas de Login vs Registro
    const tabLoginBtn = document.getElementById('tabLoginBtn');
    const tabRegisterBtn = document.getElementById('tabRegisterBtn');
    const loginView = document.getElementById('loginView');
    const registerView = document.getElementById('registerView');
    const authBoxTitle = document.getElementById('authBoxTitle');
    const authBoxSubtitle = document.getElementById('authBoxSubtitle');

    if (tabLoginBtn && tabRegisterBtn) {
        tabLoginBtn.addEventListener('click', () => {
            tabLoginBtn.classList.add('active');
            tabRegisterBtn.classList.remove('active');
            loginView.style.display = 'block';
            registerView.style.display = 'none';
            authBoxTitle.innerText = 'Acesso Restrito';
            authBoxSubtitle.innerText = 'Acesse com sua conta autorizada para visualizar os preços.';
            hideAuthAlert();
        });

        tabRegisterBtn.addEventListener('click', () => {
            tabRegisterBtn.classList.add('active');
            tabLoginBtn.classList.remove('active');
            loginView.style.display = 'none';
            registerView.style.display = 'block';
            authBoxTitle.innerText = 'Solicitar Acesso';
            authBoxSubtitle.innerText = 'Preencha seus dados para solicitar liberação ao administrador.';
            hideAuthAlert();
        });
    }

    document.getElementById('btnGoogleLogin').addEventListener('click', handleGoogleLogin);
    document.getElementById('loginForm').addEventListener('submit', handleEmailLogin);
    document.getElementById('registerForm').addEventListener('submit', handleRegister);
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
    document.getElementById('btnPendingLogout').addEventListener('click', handleLogout);

    // Modal de Aprovações do Administrador
    const btnAdmin = document.getElementById('btnAdminUsers');
    const modalAdmin = document.getElementById('adminUsersModal');
    const btnCloseModal = document.getElementById('btnCloseAdminModal');

    if (btnAdmin && modalAdmin) {
        btnAdmin.addEventListener('click', () => modalAdmin.style.display = 'flex');
        if (btnCloseModal) btnCloseModal.addEventListener('click', () => modalAdmin.style.display = 'none');
        modalAdmin.addEventListener('click', (e) => {
            if (e.target === modalAdmin) modalAdmin.style.display = 'none';
        });
    }

    document.getElementById('togglePasswordBtn').addEventListener('click', () => {
        const inp = document.getElementById('loginPassword');
        const isPass = inp.type === 'password';
        inp.type = isPass ? 'text' : 'password';
        document.getElementById('eyeIcon').className = isPass ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    });

    document.getElementById('configToggleBtn').addEventListener('click', () => {
        const p = document.getElementById('configContent');
        p.style.display = p.style.display === 'block' ? 'none' : 'block';
    });

    document.getElementById('saveConfigBtn').addEventListener('click', () => {
        const key = document.getElementById('cfgApiKey').value.trim();
        const proj = document.getElementById('cfgProjectId').value.trim();
        if (key && proj) {
            localStorage.setItem('firebase_api_key', key);
            localStorage.setItem('firebase_project_id', proj);
            alert('Configurações salvas!');
            document.getElementById('configContent').style.display = 'none';
            initFirebase();
        }
    });

    // Enquadrar Estado de MT
    document.getElementById('btnFitMT').addEventListener('click', () => {
        if (state.map) {
            if (state.mtBounds) {
                state.map.fitBounds(state.mtBounds, { padding: [20, 20] });
            } else {
                state.map.fitBounds(MT_DEFAULT_BOUNDS);
            }
        }
    });

    // Chips de Combustível
    const chips = document.querySelectorAll('#fuelSelector .filter-chip');
    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            chips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            state.currentFuel = chip.getAttribute('data-fuel');
            applyFilters();
        });
    });

    // Seletor de Período dos Gráficos (7D, 1M, 6M, 1A, Tudo)
    const periodChips = document.querySelectorAll('#chartPeriodSelector .period-chip');
    periodChips.forEach(pChip => {
        pChip.addEventListener('click', () => {
            periodChips.forEach(p => p.classList.remove('active'));
            pChip.classList.add('active');
            state.chartPeriod = pChip.getAttribute('data-period');
            renderCharts();
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
    const clearBtn = document.getElementById('clearSearchBtn');
    let debounce;
    searchInput.addEventListener('input', (e) => {
        const v = e.target.value;
        clearBtn.style.display = v ? 'block' : 'none';
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            state.searchQuery = v;
            applyFilters();
        }, 250);
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        state.searchQuery = '';
        applyFilters();
    });

    document.getElementById('btnRefreshData').addEventListener('click', loadDataFromFirestore);
    document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);
}

function showAuth() {
    document.getElementById('authGate').style.display = 'flex';
    document.getElementById('dashboardContent').style.display = 'none';
    document.getElementById('userSession').style.display = 'none';
    document.getElementById('syncStatusText').innerText = 'Acesso restrito';
}

function showDashboard(user) {
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('dashboardContent').style.display = 'block';
    document.getElementById('userSession').style.display = 'flex';
    document.getElementById('userEmailLabel').innerText = user.email || 'Usuário Google';
}

function showAuthAlert(msg, type = 'error') {
    const a = document.getElementById('authAlert');
    document.getElementById('authAlertMsg').innerText = msg;
    a.style.display = 'flex';
}

function hideAuthAlert() {
    document.getElementById('authAlert').style.display = 'none';
}

function setLoginLoading(isLoading) {
    document.getElementById('loginSubmitBtn').disabled = isLoading;
    document.getElementById('btnSubmitText').style.display = isLoading ? 'none' : 'inline';
    document.getElementById('btnSubmitSpinner').style.display = isLoading ? 'inline-block' : 'none';
}

function formatDate(str) {
    try {
        const dt = new Date(str);
        return dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
    } catch { return str; }
}

function exportToCSV() {
    if (state.filteredData.length === 0) return;
    const headers = ['ID', 'Posto', 'Combustivel', 'Preco', 'Municipio', 'Distancia_KM', 'Data_Emissao'];
    const rows = state.filteredData.map(item => [
        `"${item.id}"`, `"${item.nome_emissor.replace(/"/g, '""')}"`, `"${item.desc_produto}"`,
        item.valor, `"${item.municipio}"`, item.distancia, `"${item.data_emissao}"`
    ]);
    const blob = new Blob([ [headers.join(','), ...rows.map(e => e.join(','))].join('\n') ], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `combustiveis_mt_${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
}

function initTheme() {
    const saved = localStorage.getItem('app-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    document.getElementById('themeIcon').className = saved === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
}

function toggleTheme() {
    const curr = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = curr === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('app-theme', next);
    document.getElementById('themeIcon').className = next === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    renderCharts();
}
