import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
    getAuth,
    signInWithPopup,
    GoogleAuthProvider,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyBYoR_OTowzepYYgzFr3g-DHieOc6lCHVA",
    authDomain: "fuel-sync-77081.firebaseapp.com",
    projectId: "fuel-sync-77081"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

let map = null;
let markerGroup = null;
let userMarker = null;
let activeFilter = 'all';
let toastTimer = null;
let ALL_STATIONS = [];
let smartTripActive = false;
let loginInProgress = false;
let selectedService = null;
let isUserLoggedIn = false;

// ── Zoom-Based Rendering State ──
let _zoomRenderDebounce = null;
let isMapCleared = false; // blocks zoom re-render after user explicitly clears the map

/**
 * Returns the maximum number of stations to display at a given zoom level.
 * Zoom ≤ 10 → 30, Zoom 11-13 → 80, Zoom ≥ 14 → 9999 (all).
 */
function getZoomLimit(zoom) {
    if (zoom <= 10) return 30;
    if (zoom <= 13) return 80;
    return 9999; // show all at close zoom
}

/**
 * Picks the top-N stations from ALL_STATIONS sorted by distance from the
 * current map centre. N is determined by the current zoom level.
 * Returns an empty array when ALL_STATIONS is not yet populated.
 */
function getStationsForZoom() {
    if (!ALL_STATIONS || ALL_STATIONS.length === 0) return [];
    if (!map) return ALL_STATIONS;

    const center = map.getCenter();
    const limit = getZoomLimit(map.getZoom());

    // Fast-path: fewer stations than the limit → return all
    if (ALL_STATIONS.length <= limit) return [...ALL_STATIONS];

    // Sort a shallow copy by distance from map centre, take top N
    const sorted = [...ALL_STATIONS].sort((a, b) => {
        const dA = getDistance(center.lat, center.lng, a.lat, a.lng);
        const dB = getDistance(center.lat, center.lng, b.lat, b.lng);
        return dA - dB;
    });
    return sorted.slice(0, limit);
}

/**
 * Main entry-point for normal (non-route) map rendering.
 * Respects tripActive guard — skips rendering when a route is active.
 * Respects isMapCleared guard — skips rendering when user explicitly cleared the map.
 */
function renderZoomBasedMarkers() {
    if (tripActive) return; // PART 6: route mode protection
    if (isMapCleared) return; // STEP 4: cleared map — do not auto re-render
    const stations = getStationsForZoom();
    renderMarkers(stations);
}

// ── Execution Control State ──
let currentActiveCity = null;
let lastRouteKey = null;

// ── City-based data loading state ──
let selectedCity = null;
let loadedCitiesCache = {};
let loadedCitiesOrder = [];
const CACHE_LIMIT = 5;
let cityLoadingInProgress = false;

const CITY_CENTERS = {
    Nashik: { lat: 19.9975, lng: 73.7898 },
    Mumbai: { lat: 19.0760, lng: 72.8777 },
    Pune: { lat: 18.5204, lng: 73.8567 }
};

function initMap() {
    const NASHIK = [19.9975, 73.7898];
    const DEFAULT_ZOOM = 13;

    map = L.map('map', {
        center: NASHIK,
        zoom: DEFAULT_ZOOM,
        zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        maxZoom: 19,
    }).addTo(map);

    markerGroup = L.layerGroup().addTo(map);

    map.whenReady(() => {
        setTimeout(() => map.invalidateSize(), 100);
    });

    window.addEventListener('resize', () => {
        if (map) map.invalidateSize();
    });

    // ── PART 4: Zoom event → re-render markers (NO API CALL) ──
    map.on('zoomend', () => {
        if (tripActive) return; // PART 6: skip in route mode
        if (isMapCleared) return; // STEP 4: skip when map was explicitly cleared
        clearTimeout(_zoomRenderDebounce);
        _zoomRenderDebounce = setTimeout(() => {
            console.log('🔍 Zoom render — NO API CALL | zoom:', map.getZoom(), '| stations in memory:', ALL_STATIONS.length);
            renderZoomBasedMarkers();
        }, 120); // slight debounce prevents flicker (PART 7)
    });

    const loader = document.getElementById('map-loader');
    if (loader) loader.classList.add('hidden');
}

// ── FIFO cache eviction ──
function addToCache(cityName, data) {
    if (loadedCitiesCache[cityName]) {
        // Already cached — move to end of order
        loadedCitiesOrder = loadedCitiesOrder.filter(c => c !== cityName);
        loadedCitiesOrder.push(cityName);
        return;
    }
    // Evict oldest if at limit
    if (loadedCitiesOrder.length >= CACHE_LIMIT) {
        const oldest = loadedCitiesOrder.shift();
        delete loadedCitiesCache[oldest];
        console.log(`[Cache] Evicted ${oldest} (FIFO limit: ${CACHE_LIMIT})`);
    }
    loadedCitiesCache[cityName] = data;
    loadedCitiesOrder.push(cityName);
}

// ── Disable/enable city buttons during loading ──
function setCityButtonsDisabled(disabled) {
    const selector = document.getElementById('city-selector');
    if (selector) selector.classList.toggle('loading', disabled);
    document.querySelectorAll('.city-btn').forEach(btn => {
        btn.disabled = disabled;
    });
}

// ── Single-city data loading with cache ──
async function loadCityData(cityName) {
    try {
        console.time("Fetch " + cityName);
        if (loadedCitiesCache[cityName]) {
            console.log("✅ CACHE HIT:", cityName);
            ALL_STATIONS = [...loadedCitiesCache[cityName]];
            allStations = ALL_STATIONS;
            const loader = document.getElementById('map-loader');
            if (loader) loader.classList.add('hidden');
            clearMarkers();
            renderZoomBasedMarkers(); // PART 1/2: zoom-limited render after cache hit
            updateMapSubtitle();
            console.log(`[CityLoader] Loaded ${cityName} from cache (${ALL_STATIONS.length} stations)`);
            console.timeEnd("Fetch " + cityName);
            return;
        }

        console.log("❌ CACHE MISS:", cityName);

        // UX: show loading state
        cityLoadingInProgress = true;
        setCityButtonsDisabled(true);
        showToast(`Loading ${cityName} stations...`);

        console.log("🔥 FETCHING FROM FIRESTORE:", cityName);
        const q = query(collection(db, "stations"), where("city", "==", cityName));
        const querySnapshot = await getDocs(q);
        const cityData = [];
        querySnapshot.forEach((doc) => {
            cityData.push(doc.data());
        });

        addToCache(cityName, cityData);
        console.log("📦 CACHE STATE:", Object.keys(loadedCitiesCache));
        ALL_STATIONS = [...cityData];
        allStations = ALL_STATIONS;

        const loader = document.getElementById('map-loader');
        if (loader) loader.classList.add('hidden');

        clearMarkers();
        renderZoomBasedMarkers(); // PART 1/2: zoom-limited render on fresh fetch
        updateMapSubtitle();

        // UX: handle empty data
        if (cityData.length === 0) {
            showToast(`No stations found in ${cityName}`, 'error', 3500);
        } else {
            showToast(`${cityData.length} stations loaded for ${cityName}`, 'success', 2000);
        }
        console.log(`[CityLoader] Fetched ${cityName} from Firestore (${cityData.length} stations)`);
        console.timeEnd("Fetch " + cityName);
    } catch (error) {
        console.error(`[CityLoader] Fetch failed for ${cityName}:`, error);
        showToast(`Failed to load ${cityName} data`, 'error', 3000);
    } finally {
        cityLoadingInProgress = false;
        setCityButtonsDisabled(false);
    }
}

// ── Multi-city data loading for routes ──
async function loadMultiCityData(citiesToLoad) {
    try {
        const allCityData = [];
        const fetchPromises = [];

        showToast(`Loading stations for route (${citiesToLoad.join(', ')})...`);

        for (const city of citiesToLoad) {
            console.time("Fetch " + city);
            if (loadedCitiesCache[city]) {
                console.log("✅ CACHE HIT:", city);
                allCityData.push(...loadedCitiesCache[city]);
                console.log(`[MultiCity] ${city} loaded from cache`);
                console.timeEnd("Fetch " + city);
            } else {
                console.log("❌ CACHE MISS:", city);
                console.log("🔥 FETCHING FROM FIRESTORE:", city);
                fetchPromises.push(
                    getDocs(query(collection(db, "stations"), where("city", "==", city)))
                        .then(snapshot => {
                            const cityData = [];
                            snapshot.forEach(doc => cityData.push(doc.data()));
                            addToCache(city, cityData);
                            console.log("📦 CACHE STATE:", Object.keys(loadedCitiesCache));
                            allCityData.push(...cityData);
                            console.log(`[MultiCity] ${city} fetched from Firestore (${cityData.length} stations)`);
                            console.timeEnd("Fetch " + city);
                        })
                );
            }
        }

        await Promise.all(fetchPromises);

        // Strict 3-tier deduplication: placeId > mapsLink > lat+lng
        const seenByPlaceId = new Set();
        const seenByMapsLink = new Set();
        const seenByCoords = new Set();
        const uniqueStations = [];

        allCityData.forEach(station => {
            // Tier 1: placeId (highest priority)
            if (station.placeId) {
                if (seenByPlaceId.has(station.placeId)) return;
                seenByPlaceId.add(station.placeId);
                uniqueStations.push(station);
                return;
            }
            // Tier 2: mapsLink
            if (station.mapsLink) {
                if (seenByMapsLink.has(station.mapsLink)) return;
                seenByMapsLink.add(station.mapsLink);
                uniqueStations.push(station);
                return;
            }
            // Tier 3: lat + lng (fallback)
            const coordKey = `${station.lat}_${station.lng}`;
            if (seenByCoords.has(coordKey)) return;
            seenByCoords.add(coordKey);
            uniqueStations.push(station);
        });

        ALL_STATIONS = uniqueStations;
        allStations = ALL_STATIONS;

        if (uniqueStations.length === 0) {
            showToast('No stations found along this route', 'error', 3500);
        }

        console.log(`[MultiCity] Total unique stations loaded: ${ALL_STATIONS.length} from [${citiesToLoad.join(', ')}]`);
    } catch (error) {
        console.error("[MultiCity] Multi-city fetch failed:", error);
        showToast('Failed to load route stations', 'error', 3000);
    }
}

// ── Detect which cities a route passes through ──
function detectRouteCities(routeCoords, startCoords, endCoords) {
    const cities = new Set();

    // Check start and destination proximity to known city centers (≤20 km)
    for (const [cityName, center] of Object.entries(CITY_CENTERS)) {
        const distToStart = getDistance(startCoords.lat, startCoords.lng, center.lat, center.lng);
        if (distToStart <= 20) cities.add(cityName);

        const distToEnd = getDistance(endCoords.lat, endCoords.lng, center.lat, center.lng);
        if (distToEnd <= 20) cities.add(cityName);
    }

    // Check intermediate route points for proximity to city centers (≤12 km)
    // Dynamic sampling: ~100 sample points regardless of route length
    for (const [cityName, center] of Object.entries(CITY_CENTERS)) {
        if (cities.has(cityName)) continue;
        const step = Math.max(10, Math.floor(routeCoords.length / 100));
        for (let i = 0; i < routeCoords.length; i += step) {
            const point = routeCoords[i];
            const dist = getDistance(point[1], point[0], center.lat, center.lng);
            if (dist <= 12) {
                cities.add(cityName);
                break;
            }
        }
        // Always check last point to avoid missing destination-adjacent cities
        if (!cities.has(cityName)) {
            const lastPoint = routeCoords[routeCoords.length - 1];
            const lastDist = getDistance(lastPoint[1], lastPoint[0], center.lat, center.lng);
            if (lastDist <= 12) cities.add(cityName);
        }
    }

    console.log(`[RouteDetect] Detected cities: [${Array.from(cities).join(', ')}]`);
    return Array.from(cities);
}

// ── Update map subtitle based on current data context ──
function updateMapSubtitle() {
    const subtitleEl = document.getElementById('map-subtitle');
    if (subtitleEl) subtitleEl.textContent = selectedCity ? `All Stations – ${selectedCity}` : 'Select a city to view stations';
}

// ── Switch city via UI ──
async function switchCity(cityName) {
    if (cityName === currentActiveCity) {
        console.log("🚫 Skipping reload — same city selected");
        return;
    }

    if (cityLoadingInProgress) return; // prevent overlapping loads
    currentActiveCity = cityName;
    selectedCity = cityName;

    isMapCleared = false; // STEP 5: new city action lifts the cleared flag

    // Update city selector button highlights
    document.querySelectorAll('.city-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.city === cityName);
    });

    // Pan map to city center
    const center = CITY_CENTERS[cityName];
    if (center && map) {
        map.flyTo([center.lat, center.lng], 13, { duration: 1.2 });
    }

    await loadCityData(cityName);
}

function renderMarkers(stations) {
    if (!markerGroup) return;
    markerGroup.clearLayers();

    stations.forEach((station) => {
        if (!station.lat || !station.lng) return;

        const marker = createMarker(station);
        markerGroup.addLayer(marker);
    });

    const countEl = document.getElementById('visible-count');
    if (countEl) countEl.textContent = stations.length;
}

function getStationIcon(services, options = {}) {
    let color = '#9ca3af'; // gray default
    if (services && services.length > 0) {
        const s = services.map(x => String(x).toLowerCase());
        if (s.includes('ev')) color = '#4CAF50';
        else if (s.includes('petrol')) color = '#ef4444';
        else if (s.includes('cng')) color = '#3b82f6';
    }

    let size = 16;
    let iconSize = 22;
    let anchor = 11;
    let opacity = 1;
    let pulseHtml = '';

    if (options.isBest) {
        color = '#f59e0b'; // Gold for primary recommended
        size = 22;
        iconSize = 30;
        anchor = 15;
        pulseHtml = `<div style="position: absolute; width: 100%; height: 100%; border-radius: 50%; border: 2px solid ${color}; animation: pulse 1.5s infinite;"></div>`;
        
        if (!document.getElementById('pulse-style')) {
            const style = document.createElement('style');
            style.id = 'pulse-style';
            style.innerHTML = `@keyframes pulse { 0% { transform: scale(1); opacity: 1; } 100% { transform: scale(1.5); opacity: 0; } }`;
            document.head.appendChild(style);
        }
    } else if (options.isSecondary) {
        color = '#3b82f6'; // Blue for secondary on-route option
        size = 18;
        iconSize = 26;
        anchor = 13;
        pulseHtml = `<div style="position: absolute; width: 100%; height: 100%; border-radius: 50%; border: 2px solid ${color}; opacity: 0.6; transform: scale(1.3);"></div>`;
    } else if (options.isOffRoute) {
        color = '#f97316'; // Orange for off-route fallback
        size = 14;
        iconSize = 20;
        anchor = 10;
        opacity = 0.8;
    } else if (options.isOnRoute) {
        color = '#3b82f6'; // Blue for standard on-route
    }

    return L.divIcon({
        className: 'custom-station-icon',
        html: `<div style="position: relative; background-color: ${color}; width: ${size}px; height: ${size}px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3); opacity: ${opacity}; display: flex; justify-content: center; align-items: center;">${pulseHtml}</div>`,
        iconSize: [iconSize, iconSize],
        iconAnchor: [anchor, anchor],
        popupAnchor: [0, -anchor]
    });
}

function createMarker(station, options = {}) {
    const icon = getStationIcon(station.services, options);
    const marker = L.marker([station.lat, station.lng], { icon, zIndexOffset: options.isBest ? 1000 : 0 });

    // ── XSS fix: escape all Firestore-sourced values before HTML insertion ──
    const safeName = escapeHTML(station.name);
    const rawLink = station.mapsLink;
    const validatedLink = safeLink(rawLink);
    const safeHref = escapeHTML(validatedLink);

    let badgesHTML = '';
    if (station.services) {
        badgesHTML = station.services.map(svc => {
            let className = 'popup-badge';
            const type = String(svc).toLowerCase();
            if (type === 'ev') className += ' EV';
            else if (type === 'petrol') className += ' petrol';
            else if (type === 'cng') className += ' CNG';
            // escapeHTML applied to svc — it is a Firestore value
            return `<span class="${className}">${escapeHTML(svc)}</span>`;
        }).join('');
    }

    let topLabel = '';
    if (options.isBest) {
        topLabel = `<b style="color: #f59e0b; font-size: 0.9em; display:block; margin-bottom:5px;">⭐ Recommended Station</b>`;
    } else if (options.isSecondary) {
        topLabel = `<b style="color: #3b82f6; font-size: 0.9em; display:block; margin-bottom:5px;">📍 On Route Alternative</b>`;
    } else if (options.isOffRoute) {
        topLabel = `<b style="color: #f97316; font-size: 0.9em; display:block; margin-bottom:5px;">🚨 Off Route — Nearby Option</b>`;
    }

    marker.bindPopup(`
    <div class="station-popup">
      ${topLabel}
      <div class="popup-name">${safeName}</div>
      <div style="margin-bottom: 15px;">
        ${badgesHTML}
      </div>
      <a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="popup-nav-btn" style="text-decoration:none; text-align:center;">
        Navigate
      </a>
    </div>
  `);

    return marker;
}

window.handleNavigation = function (lat, lng) {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    window.open(url, '_blank', 'noopener,noreferrer');
};

let currentMarkers = [];

function clearMarkers() {
    currentMarkers.forEach(marker => map.removeLayer(marker));
    currentMarkers = [];
    if (window.markerGroup) window.markerGroup.clearLayers();
}

function showFilteredStations(service) {
    isMapCleared = false; // STEP 5: explicit service filter lifts the cleared flag

    if (window.routeLayer) {
        map.removeLayer(window.routeLayer);
        window.routeLayer = null;
    }
    clearMarkers();

    const filtered = allStations.filter(station =>
        station.services && station.services.some(svc => String(svc).toLowerCase() === service.toLowerCase())
    );

    filtered.forEach(station => {
        const marker = createMarker(station).addTo(map);
        currentMarkers.push(marker);
    });
}

function filterStations(type) {
    activeFilter = type;

    const filtered = type === 'all'
        ? ALL_STATIONS
        : ALL_STATIONS.filter((s) => s.services && s.services.some(svc => String(svc).toLowerCase() === String(type).toLowerCase()));

    renderMarkers(filtered);
    updateCounts(filtered);
    updateFilterButtons(type);

    const subtitleEl = document.getElementById('map-subtitle');
    const citySuffix = selectedCity ? ` – ${selectedCity}` : '';
    const labelMap = { all: `All Stations${citySuffix}`, EV: `EV Charging${citySuffix}`, petrol: `Petrol Pumps${citySuffix}`, CNG: `CNG Stations${citySuffix}` };
    if (subtitleEl) subtitleEl.textContent = labelMap[type] || (selectedCity ? selectedCity : 'Select a city to view stations');
}

function updateFilterButtons(activeType) {
    const buttons = document.querySelectorAll('.filter-btn');
    buttons.forEach((btn) => {
        const isActive = btn.dataset.type === activeType;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
    });
}

function updateCounts(visibleStations) {
    const counts = { EV: 0, petrol: 0, CNG: 0 };
    visibleStations.forEach((s) => {
        if (s.services) {
            s.services.forEach(svc => {
                const t = String(svc).toLowerCase();
                if (t === 'ev') counts.EV++;
                if (t === 'petrol') counts.petrol++;
                if (t === 'cng') counts.CNG++;
            });
        }
    });

    setTextContent('ev-count', counts.EV);
    setTextContent('petrol-count', counts.petrol);
    setTextContent('cng-count', counts.CNG);

    setTextContent('stat-total', visibleStations.length);
    setTextContent('stat-ev', counts.EV);
    setTextContent('stat-petrol', counts.petrol);
    setTextContent('stat-cng', counts.CNG);
}

function locateUser() {
    if (!navigator.geolocation) {
        showToast('Geolocation not supported by your browser.', 'error');
        return;
    }

    showToast('Locating you…');

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;

            if (userMarker) map.removeLayer(userMarker);

            const userIcon = L.divIcon({
                className: '',
                html: `<div class="user-marker" title="Your location" aria-label="Your current location"></div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10],
                popupAnchor: [0, -14],
            });

            userMarker = L.marker([latitude, longitude], { icon: userIcon, zIndexOffset: 1000 })
                .addTo(map)
                .bindPopup('<div class="station-popup"><p class="popup-name">📍 You are here</p></div>')
                .openPopup();

            map.flyTo([latitude, longitude], 14, { duration: 1.5 });
            showToast('You have been located!', 'success');
        },
        (error) => {
            const messages = {
                1: 'Location permission denied.',
                2: 'Location unavailable.',
                3: 'Location request timed out.',
            };
            showToast(messages[error.code] || 'Could not get your location.', 'error');
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function showToast(message, type = 'info', duration = 2800) {
    const toast = document.getElementById('locate-toast');
    const msgEl = document.getElementById('toast-msg');
    if (!toast || !msgEl) return;

    msgEl.textContent = message;

    toast.style.background =
        type === 'error' ? '#dc2626' :
            type === 'success' ? '#16a34a' : '#1f2937';

    toast.classList.add('show');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

function setTextContent(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Validates a URL scheme and returns the original URL if safe.
 * Scheme check uses lowercase to handle mixed-case (HTTPS://, Http://).
 * The original URL is returned unchanged — path/query are never modified.
 * Anything that is not http(s) is replaced with '#' to block
 * javascript:, data:, vbscript:, and similar injection schemes.
 */
function safeLink(url) {
    const raw = String(url || '').trim();
    const lower = raw.toLowerCase();

    if (lower.startsWith('https://') || lower.startsWith('http://')) {
        return raw; // return original — do NOT lowercase the full URL
    }

    // Temporary debug log — remove after Firestore data is verified
    console.warn('[safeLink] Blocked unsafe or empty link:', url);
    return '#';
}

function getDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function clampSmartScore(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
}

function clampSmartRatio(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function getRouteProximityEvaluation(distanceToRoute) {
    if (distanceToRoute <= 0.2) {
        return { level: 'High', score: 100 };
    }
    if (distanceToRoute <= 1) {
        return { level: 'Medium', score: 70 };
    }
    if (distanceToRoute <= 4) {
        return { level: 'Low', score: 40 };
    }
    return { level: 'Low', score: 0 };
}

function getStationConfidence(distanceToRoute) {
    if (distanceToRoute <= 0.2) {
        return { level: 'High Confidence', badge: 'High', className: 'high' };
    }
    if (distanceToRoute <= 1) {
        return { level: 'Medium Confidence', badge: 'Medium', className: 'medium' };
    }
    return { level: 'Low Confidence', badge: 'Low', className: 'low' };
}

function getBatteryProgressProfile(battery) {
    if (battery <= 20) {
        return {
            min: 0,
            max: 0.30,
            target: 0.15,
            reason: 'prioritized early because your current fuel level is low'
        };
    }
    if (battery >= 21 && battery <= 50) {
        return {
            min: 0.30,
            max: 0.60,
            target: 0.45,
            reason: 'matches your current fuel level with a mid-route stop'
        };
    }
    if (battery >= 51 && battery <= 80) {
        return {
            min: 0.60,
            max: 0.85,
            target: 0.725,
            reason: 'fits a later stop for your current fuel level'
        };
    }
    return {
        min: 0.85,
        max: 1,
        target: 0.925,
        reason: 'keeps the stop late because your current fuel level is high'
    };
}

function formatSmartDistance(km) {
    if (!Number.isFinite(km)) return 'unknown distance';
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1).replace(/\.0$/, '')} km`;
    return `${Math.round(km)} km`;
}

function getProgressMatchScore(progressRatio, expectedRatio) {
    return clampSmartScore(100 - (Math.abs(progressRatio - expectedRatio) * 100));
}

function getBatterySuitabilityScore(progressRatio, profile) {
    if (progressRatio >= profile.min && progressRatio <= profile.max) {
        return 100;
    }

    const gap = progressRatio < profile.min
        ? profile.min - progressRatio
        : progressRatio - profile.max;

    return clampSmartScore(100 - (gap * 100));
}

function getRouteAlignmentText(distanceToRoute) {
    const offRouteDistance = formatSmartDistance(distanceToRoute);

    if (distanceToRoute <= 0.2) {
        return `station is directly aligned with the route (${offRouteDistance} off-route)`;
    }
    if (distanceToRoute <= 1) {
        return `station is within ${offRouteDistance} of the route`;
    }
    return `station is within ${offRouteDistance} of the route`;
}

function buildStationExplanation(station, battery) {
    const aheadDistance = formatSmartDistance(station.positionAlongRoute);
    const profile = getBatteryProgressProfile(battery);
    const routeAlignment = getRouteAlignmentText(station.distanceToRoute);

    return `Recommended stop ${aheadDistance} ahead on your route, ${profile.reason}; ${routeAlignment}.`;
}

function evaluateStation(station, routeData, battery) {
    const totalRouteDistance = routeData && Number.isFinite(routeData.totalRouteDistance)
        ? routeData.totalRouteDistance
        : 0;
    const progressRatio = Number.isFinite(station.progressRatio)
        ? clampSmartRatio(station.progressRatio)
        : clampSmartRatio(station.positionAlongRoute / totalRouteDistance);
    const proximity = getRouteProximityEvaluation(station.distanceToRoute);
    const profile = getBatteryProgressProfile(battery);
    const confidence = getStationConfidence(station.distanceToRoute);
    const progressMatchScore = getProgressMatchScore(progressRatio, profile.target);
    const batterySuitabilityScore = getBatterySuitabilityScore(progressRatio, profile);
    const score = clampSmartScore(
        (proximity.score * 0.4) +
        (progressMatchScore * 0.35) +
        (batterySuitabilityScore * 0.25)
    );

    return {
        score,
        routeProximityLevel: proximity.level,
        routeProximityScore: proximity.score,
        progressMatchScore,
        batterySuitabilityScore,
        expectedProgressRatio: profile.target,
        confidenceLevel: confidence.level,
        confidenceBadge: confidence.badge,
        confidenceClassName: confidence.className,
        explanation: buildStationExplanation(station, battery)
    };
}

let tripActive = false;
let allStations = [];
let markers = [];
window.routeLayer = null;

function findNearest(user, stations) {
    let nearest = null;
    let minDistance = Infinity;

    stations.forEach(station => {
        if (!station.lat || !station.lng) return;
        const d = getDistance(user.lat, user.lng, station.lat, station.lng);
        if (d < minDistance) {
            minDistance = d;
            nearest = station;
        }
    });

    return nearest;
}

async function geocodeLocation(query) {
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&addressdetails=1&limit=5`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data || data.length === 0) {
        throw new Error("Location not found");
    }

    // Prefer Maharashtra results
    const result = data.find(place =>
        place.display_name.toLowerCase().includes("maharashtra")
    ) || data[0];

    return {
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon)
    };
}

function toggleTrip() {
    if (!tripActive) {
        // Show Modal if available, or just start it.
        // The previous design expects the user to fill the modal. We'll show the modal instead.
        const modal = document.getElementById('plan-trip-modal');
        if (modal) modal.classList.remove('hidden');
    } else {
        endTrip();
    }
}

async function startTrip() {
    tripActive = true;

    document.getElementById("tripBtn").innerText = "End Trip";

    try {

        const serviceType = document.querySelector('input[name="trip-service"]:checked').value;
        const startType = document.querySelector('input[name="start-type"]:checked').value;
        const startQuery = document.getElementById('trip-start-input').value;
        const destQuery = document.getElementById('trip-dest-input').value;

        let start = null;
        if (startType === 'current') {
            if (!navigator.geolocation) throw new Error('Geolocation not supported');
            showToast('Getting your location...');
            start = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(
                    pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
                    err => reject(new Error('Please allow location access'))
                );
            });
        } else {
            if (!startQuery.trim()) throw new Error('Start location empty');
            start = await geocodeLocation(startQuery);
        }

        if (!destQuery.trim()) throw new Error('Destination empty');
        showToast('Planning your route...');
        let end = await geocodeLocation(destQuery);

        console.log("START:", start);
        console.log("END:", end);

        const routeKey = `${start.lat},${start.lng}→${end.lat},${end.lng}`;
        if (routeKey === lastRouteKey) {
            console.log("🚫 Skipping route processing — same route");
            const modal = document.getElementById('plan-trip-modal');
            if (modal) modal.classList.add('hidden');
            return;
        }
        lastRouteKey = routeKey;

        const routeUrl = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`;
        const response = await fetch(routeUrl);
        if (!response.ok) throw new Error('OSRM fetch failed');
        const data = await response.json();

        if (!data.routes || data.routes.length === 0) {
            throw new Error('No route returned');
        }

        const routeGeoJSON = data.routes[0].geometry;

        if (window.routeLayer) {
            map.removeLayer(window.routeLayer);
        }

        markers.forEach(m => map.removeLayer(m));
        markers = [];

        if (markerGroup) markerGroup.clearLayers();
        if (userMarker) map.removeLayer(userMarker);

        window.routeLayer = L.geoJSON(routeGeoJSON, {
            style: { color: '#3b82f6', weight: 5, opacity: 0.8 }
        }).addTo(map);

        map.fitBounds(window.routeLayer.getBounds(), { padding: [50, 50] });

        const routeCoords = routeGeoJSON.coordinates;
        window.currentRouteCoords = routeCoords;
        window.currentUserLocation = start;
        window.currentSelectedService = serviceType;

        // ── Route-based multi-city loading ──
        const citiesToLoad = detectRouteCities(routeCoords, start, end);
        if (citiesToLoad.length > 0) {
            await loadMultiCityData(citiesToLoad);
        }

        // ── Route corridor filtering ──

        // Build cumulative distance array for route progress tracking
        const cumDist = [0];
        let totalRouteDist = 0;
        for (let i = 1; i < routeCoords.length; i++) {
            const p1 = routeCoords[i - 1];
            const p2 = routeCoords[i];
            totalRouteDist += getDistance(p1[1], p1[0], p2[1], p2[0]);
            cumDist.push(totalRouteDist);
        }

        // Dynamic sampling step — ~200 samples regardless of route length
        const sampleStep = Math.max(1, Math.floor(routeCoords.length / 200));

        // Measure each station against the route
        const measuredStations = [];
        allStations.forEach(station => {
            if (!station.lat || !station.lng) return;

            // Service type filter
            let hasService = false;
            if (station.services && station.services.length > 0) {
                hasService = station.services.some(svc => String(svc).toLowerCase() === serviceType.toLowerCase());
            } else {
                hasService = serviceType.toLowerCase() === 'ev';
            }
            if (!hasService) return;

            // Find closest route point
            let minRouteDist = Infinity;
            let closestIdx = 0;
            for (let i = 0; i < routeCoords.length; i += sampleStep) {
                const point = routeCoords[i];
                const dist = getDistance(station.lat, station.lng, point[1], point[0]);
                if (dist < minRouteDist) {
                    minRouteDist = dist;
                    closestIdx = i;
                }
            }
            // Refine: check neighbors of closest sampled point for precision
            const refineStart = Math.max(0, closestIdx - sampleStep);
            const refineEnd = Math.min(routeCoords.length - 1, closestIdx + sampleStep);
            for (let i = refineStart; i <= refineEnd; i++) {
                const point = routeCoords[i];
                const dist = getDistance(station.lat, station.lng, point[1], point[0]);
                if (dist < minRouteDist) {
                    minRouteDist = dist;
                    closestIdx = i;
                }
            }

            // Position along route (km from start)
            const positionAlongRoute = cumDist[closestIdx];
            const progressRatio = totalRouteDist > 0 ? positionAlongRoute / totalRouteDist : 0;

            // Strict corridor: discard anything > 4 km from route
            if (minRouteDist > 4) return;

            // Discard stations behind start (< 0.5 km along route)
            if (positionAlongRoute < 0.5) return;

            // Assign corridor tier for priority sorting
            let corridorTier = 3; // 2-4 km
            if (minRouteDist <= 1) corridorTier = 1;      // ideal
            else if (minRouteDist <= 2) corridorTier = 2;  // acceptable

            measuredStations.push({
                ...station,
                routeDist: minRouteDist,
                positionAlongRoute,
                progressRatio,
                corridorTier,
                userDist: getDistance(start.lat, start.lng, station.lat, station.lng)
            });
        });

        // ── Strict tier-based selection ──
        // Show ALL stations from the closest available corridor only
        let filteredStations = [];
        const tier1 = measuredStations.filter(s => s.corridorTier === 1);
        const tier2 = measuredStations.filter(s => s.corridorTier <= 2);
        const tier3 = measuredStations; // all ≤4km already

        if (tier1.length > 0) {
            filteredStations = tier1;
        } else if (tier2.length > 0) {
            filteredStations = tier2;
        } else {
            filteredStations = tier3;
        }

        // Sort within selected tier: route distance → forward progress → user distance
        filteredStations.sort((a, b) => {
            if (Math.abs(a.routeDist - b.routeDist) > 0.1) return a.routeDist - b.routeDist;
            if (Math.abs(a.positionAlongRoute - b.positionAlongRoute) > 0.5) return a.positionAlongRoute - b.positionAlongRoute;
            return a.userDist - b.userDist;
        });

        // Handle empty result
        if (filteredStations.length === 0) {
            showToast('No stations found along your route', 'error', 3500);
        } else {
            // Render corridor-filtered stations
            filteredStations.forEach(station => {
                const marker = createMarker(station).addTo(map);
                markers.push(marker);
            });
            showToast(`Found ${filteredStations.length} stations along the route.`, 'success');
        }

        const modal = document.getElementById('plan-trip-modal');
        if (modal) modal.classList.add('hidden');
    } catch (err) {
        console.warn(err);
        if (err.message.includes('No route') || err.message.includes('fetch failed')) {
            alert('Route unavailable, opening Google Maps');
            // window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destQuery)}`, '_blank');
        } else if (err.message === 'Location not found') {
            alert("Location not found");
        } else {
            alert(err.message);
        }
        endTrip(); // Revert active state on err
    }
}

function endTrip() {
    if (!tripActive) return; // Guard: do nothing if no trip is currently active

    tripActive = false;
    lastRouteKey = null;

    document.getElementById("tripBtn").innerText = "Plan Your Trip";

    // remove route
    if (window.routeLayer) {
        map.removeLayer(window.routeLayer);
    }

    // remove markers
    markers.forEach(m => map.removeLayer(m));
    markers = [];

    // remove legend
    const legend = document.getElementById('smart-legend');
    if (legend) legend.remove();

    // Revert to single city mode
    const center = CITY_CENTERS[selectedCity] || CITY_CENTERS.Nashik;
    map.setView([center.lat, center.lng], 12);

    // Reload selected city data only
    if (selectedCity) {
        loadCityData(selectedCity);
    } else {
        updateMapSubtitle();
        clearMarkers();
    }
}

function handleNearbyStation() {
    if (!selectedService) {
        const modal = document.getElementById('nearby-error-modal');
        if (modal) modal.classList.remove('hidden');
        return;
    }

    const stationsList = (typeof allStations !== 'undefined') ? allStations : ALL_STATIONS;

    if (!stationsList || stationsList.length === 0) {
        alert('No stations found');
        return;
    }

    if (!navigator.geolocation) {
        alert('Please allow location access');
        return;
    }

    navigator.geolocation.getCurrentPosition(
        async (position) => {
            const userLat = position.coords.latitude;
            const userLng = position.coords.longitude;

            if (userMarker) map.removeLayer(userMarker);

            const userIcon = L.divIcon({
                className: '',
                html: `<div class="user-marker" title="Your location" aria-label="Your current location"></div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10],
                popupAnchor: [0, -14],
            });

            userMarker = L.marker([userLat, userLng], { icon: userIcon, zIndexOffset: 1000 })
                .addTo(map)
                .bindPopup('<div class="station-popup"><p class="popup-name">📍 You are here</p></div>');

            const validStations = stationsList.filter(station =>
                station.services && station.services.some(svc => String(svc).toLowerCase() === selectedService.toLowerCase())
            );

            const stationsWithDist = validStations.map(station => {
                return {
                    ...station,
                    _dist: getDistance(userLat, userLng, station.lat, station.lng)
                };
            }).sort((a, b) => a._dist - b._dist);

            const topClosest = stationsWithDist.slice(0, 5);

            if (window.routeLayer) {
                map.removeLayer(window.routeLayer);
                window.routeLayer = null;
            }
            clearMarkers();

            topClosest.forEach(station => {
                const marker = createMarker(station).addTo(map);
                currentMarkers.push(marker);
            });

            if (topClosest.length > 0) {
                const closestStation = topClosest[0];
                try {
                    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${userLng},${userLat};${closestStation.lng},${closestStation.lat}?overview=full&geometries=geojson`;
                    const response = await fetch(osrmUrl);
                    if (response.ok) {
                        const data = await response.json();
                        if (data.routes && data.routes.length > 0) {
                            const routeGeoJSON = data.routes[0].geometry;
                            window.routeLayer = L.geoJSON(routeGeoJSON, {
                                style: { color: 'orange', weight: 5, opacity: 0.8 }
                            }).addTo(map);
                        }
                    }
                } catch (e) {
                    console.error('Route error:', e);
                }

                let itemsToGroup = [userMarker, ...currentMarkers];
                if (window.routeLayer) itemsToGroup.push(window.routeLayer);

                const group = new L.featureGroup(itemsToGroup);
                map.fitBounds(group.getBounds(), { padding: [50, 50] });
                showToast(`Showing nearest ${selectedService} stations`, 'success', 3000);
            } else {
                showToast('No nearby stations found for this type', 'error');
            }
        },
        (error) => {
            alert('Please allow location access');
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function bindEvents() {
    const evBtn = document.getElementById("evBtn");
    if (evBtn) evBtn.onclick = () => { selectedService = "EV"; showFilteredStations("EV"); };

    const petrolBtn = document.getElementById("petrolBtn");
    if (petrolBtn) petrolBtn.onclick = () => { selectedService = "Petrol"; showFilteredStations("Petrol"); };

    const cngBtn = document.getElementById("cngBtn");
    if (cngBtn) cngBtn.onclick = () => { selectedService = "CNG"; showFilteredStations("CNG"); };

    const clearBtn = document.getElementById("clearBtn");
    if (clearBtn) clearBtn.onclick = () => {
        // STEP 3: raise the cleared flag BEFORE wiping markers so the
        // markerGroup.clearLayers() call inside clearMarkers() cannot
        // be immediately undone by a pending zoomend debounce.
        isMapCleared = true;
        clearTimeout(_zoomRenderDebounce); // STEP 3: cancel any pending re-render

        // ── State reset: clear trip flags so zoom/city/new trip all work again ──
        tripActive = false;
        lastRouteKey = null;
        selectedService = null;

        // Reset trip button UI (tripBtn / smartEndBtn) if they exist
        const tripBtn = document.getElementById('tripBtn');
        const smartEndBtn = document.getElementById('smartEndBtn');
        if (tripBtn) {
            tripBtn.style.display = 'inline-block';
            tripBtn.innerText = 'Plan Your Trip'; // Reset text just like endTrip() does
        }
        if (smartEndBtn) smartEndBtn.style.display = 'none';

        // Remove route layer if present
        if (window.routeLayer) {
            map.removeLayer(window.routeLayer);
            window.routeLayer = null;
        }

        // STEP 1: remove every known marker pool
        clearMarkers();                              // currentMarkers[] + markerGroup
        markers.forEach(m => map.removeLayer(m));    // trip/smart markers
        markers = [];
        if (markerGroup) markerGroup.clearLayers();  // belt-and-suspenders

        // STEP 6: UX feedback
        showToast('Map cleared', 'info', 2000);
    };

    const closeNearbyErrorBtn = document.getElementById("close-nearby-error-btn");
    const okNearbyErrorBtn = document.getElementById("ok-nearby-error-btn");
    const nearbyErrorModal = document.getElementById("nearby-error-modal");

    if (closeNearbyErrorBtn) closeNearbyErrorBtn.onclick = () => { if (nearbyErrorModal) nearbyErrorModal.classList.add("hidden"); };
    if (okNearbyErrorBtn) okNearbyErrorBtn.onclick = () => { if (nearbyErrorModal) nearbyErrorModal.classList.add("hidden"); };

    const locateBtn = document.getElementById('locate-me-btn');
    if (locateBtn) locateBtn.addEventListener('click', locateUser);

    const nearbyBtn = document.getElementById('btn-nearby');
    if (nearbyBtn) nearbyBtn.addEventListener('click', () => {
        if (!requireLogin()) return;
        handleNearbyStation();
    });

    const planTripBtn = document.getElementById('tripBtn');
    const planTripModal = document.getElementById('plan-trip-modal');
    const closeTripModalBtn = document.getElementById('close-modal-btn');
    const submitTripBtn = document.getElementById('submit-trip-btn');
    const startTypeRadios = document.querySelectorAll('input[name="start-type"]');
    const startInput = document.getElementById('trip-start-input');
    const destInput = document.getElementById('trip-dest-input');

    if (planTripBtn) {
        planTripBtn.addEventListener('click', () => {
            if (!requireLogin()) return;
            toggleTrip();
        });
    }

    if (planTripModal) {
        closeTripModalBtn.addEventListener('click', () => {
            planTripModal.classList.add('hidden');
        });

        planTripModal.addEventListener('click', (e) => {
            if (e.target === planTripModal) {
                planTripModal.classList.add('hidden');
            }
        });

        startTypeRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (e.target.value === 'custom') {
                    startInput.classList.remove('hidden');
                } else {
                    startInput.classList.add('hidden');
                }
            });
        });

        submitTripBtn.addEventListener('click', () => {
            // modal's job is purely to be the input UI. When submitted, we start trip.
            startTrip();
        });
    }

    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (window.routeLayer) map.removeLayer(window.routeLayer);
            markers.forEach(m => map.removeLayer(m));
            markers = [];
            clearMarkers();

            // Revert to selected city center
            const center = CITY_CENTERS[selectedCity] || CITY_CENTERS.Nashik;
            if (map) map.flyTo([center.lat, center.lng], 13, { duration: 1.2 });
            showToast('Filters reset.', 'info', 2000);

            // if trip is active end it, otherwise just reload selected city
            if (tripActive) {
                endTrip();
            } else {
                loadCityData(selectedCity);
            }
        });
    }

    const fullscreenBtn = document.getElementById('fullscreen-btn');
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', () => {
            const mapCard = document.querySelector('.map-card');
            if (!document.fullscreenElement) {
                mapCard.requestFullscreen?.();
            } else {
                document.exitFullscreen?.();
            }
        });
    }

    const smartSuggestBtn = document.getElementById('btn-smart-suggest');
    if (smartSuggestBtn) {
        smartSuggestBtn.addEventListener('click', () => {
            if (!requireLogin()) return;
            openSmartSuggestionForm();
        });
    }

    const smartSuggestionModal = document.getElementById('smart-suggestion-modal');
    if (smartSuggestionModal) {
        document.getElementById('close-smart-modal-btn')?.addEventListener('click', () => {
            smartSuggestionModal.classList.add('hidden');
        });
        smartSuggestionModal.addEventListener('click', (e) => {
            if (e.target === smartSuggestionModal) {
                smartSuggestionModal.classList.add('hidden');
            }
        });

        const smartStartTypeRadios = document.querySelectorAll('input[name="smart-start-type"]');
        const smartStartInput = document.getElementById('smart-start-input');

        smartStartTypeRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (e.target.value === 'custom') {
                    smartStartInput.classList.remove('hidden');
                } else {
                    smartStartInput.classList.add('hidden');
                }
            });
        });

        document.getElementById('submit-smart-btn')?.addEventListener('click', () => {
            handleSmartSuggestionSubmit();
        });
    }

    const smartEndBtn = document.getElementById('smartEndBtn');
    if (smartEndBtn) {
        smartEndBtn.addEventListener('click', endSmartTrip);
    }

    const loginBtn = document.getElementById("loginBtn");
    const logoutBtn = document.getElementById("logoutBtn");

    if (loginBtn) {
        loginBtn.onclick = async () => {
            if (loginInProgress) return; // prevent multiple clicks

            loginInProgress = true;
            loginBtn.disabled = true;

            try {
                const result = await signInWithPopup(auth, provider);
                console.log("LOGIN SUCCESS:", result.user);
            } catch (error) {
                // IGNORE this specific error
                if (error.code === "auth/cancelled-popup-request" || error.code === "auth/popup-closed-by-user") {
                    console.warn("Popup cancelled due to multiple clicks or user close");
                } else {
                    console.error("ERROR:", error);
                    alert(error.message);
                }
            } finally {
                loginInProgress = false;
                loginBtn.disabled = false;
            }
        };
    }

    if (logoutBtn) {
        logoutBtn.onclick = async () => {
            try {
                await signOut(auth);
            } catch (error) {
                console.error("Logout Error:", error);
            }
        };
    }

    const modalLoginBtn = document.getElementById("modal-login-btn");
    if (modalLoginBtn) {
        modalLoginBtn.onclick = async () => {
            const loginModal = document.getElementById("login-prompt-modal");
            if (loginModal) loginModal.classList.add("hidden");
            if (loginBtn) loginBtn.click();
        };
    }

    const closeLoginPromptBtn = document.getElementById("close-login-prompt-btn");
    const loginPromptModal = document.getElementById("login-prompt-modal");
    if (closeLoginPromptBtn) {
        closeLoginPromptBtn.onclick = () => {
            if (loginPromptModal) loginPromptModal.classList.add("hidden");
        };
    }

    onAuthStateChanged(auth, (user) => {
        const loginBtn = document.getElementById("loginBtn");
        const profileBox = document.getElementById("profileBox");
        const userName = document.getElementById("userName");
        const userPhoto = document.getElementById("userPhoto");

        if (!loginBtn || !profileBox || !userName || !userPhoto) return;

        if (user) {
            isUserLoggedIn = true;
            loginBtn.style.display = "none";
            profileBox.style.display = "flex";
            userName.innerText = user.displayName;
            userPhoto.src = user.photoURL;
        } else {
            isUserLoggedIn = false;
            loginBtn.style.display = "inline-block";
            profileBox.style.display = "none";
        }
    });

    const profileBox = document.getElementById("profileBox");
    const dropdown = document.getElementById("dropdownMenu");

    if (profileBox && dropdown) {
        profileBox.onclick = () => {
            dropdown.style.display =
                dropdown.style.display === "block" ? "none" : "block";
        };
    }


}


function openSmartSuggestionForm() {
    const modal = document.getElementById('smart-suggestion-modal');
    if (modal) modal.classList.remove('hidden');
}

async function handleSmartSuggestionSubmit() {
    try {
        const serviceType = document.querySelector('input[name="smart-service"]:checked').value;
        const startType = document.querySelector('input[name="smart-start-type"]:checked').value;
        const startQuery = document.getElementById('smart-start-input').value;
        const destQuery = document.getElementById('smart-dest-input').value;
        const batteryInput = document.getElementById('smart-battery-input').value;

        let battery = parseInt(batteryInput, 10);
        if (isNaN(battery) || battery < 0 || battery > 100) {
            throw new Error("Please enter a valid battery/fuel percentage (0-100).");
        }

        let start = null;
        if (startType === 'current') {
            if (!navigator.geolocation) throw new Error('Geolocation not supported');
            showToast('Getting your location...');
            start = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(
                    pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
                    err => reject(new Error('Please allow location access'))
                );
            });
        } else {
            if (!startQuery.trim()) throw new Error('Start location empty');
            start = await geocodeLocation(startQuery);
        }

        if (!destQuery.trim()) throw new Error('Destination empty');
        showToast('Processing Smart Suggestion...');
        let end = await geocodeLocation(destQuery);

        const routeKey = `${start.lat},${start.lng}→${end.lat},${end.lng}`;
        if (routeKey === lastRouteKey) {
            console.log("🚫 Skipping route — duplicate input");
            const modal = document.getElementById('smart-suggestion-modal');
            if (modal) modal.classList.add('hidden');
            return;
        }
        lastRouteKey = routeKey;

        const routeUrl = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`;
        const response = await fetch(routeUrl);
        if (!response.ok) throw new Error('OSRM fetch failed');
        const data = await response.json();

        if (!data.routes || data.routes.length === 0) {
            throw new Error('No route returned');
        }

        const routeGeoJSON = data.routes[0].geometry;

        if (window.routeLayer) {
            map.removeLayer(window.routeLayer);
        }

        markers.forEach(m => map.removeLayer(m));
        markers = [];

        if (markerGroup) markerGroup.clearLayers();
        if (userMarker) map.removeLayer(userMarker);

        window.routeLayer = L.geoJSON(routeGeoJSON, {
            style: { color: '#8b5cf6', weight: 5, opacity: 0.8 } // Purple for smart route
        }).addTo(map);

        map.fitBounds(window.routeLayer.getBounds(), { padding: [50, 50] });

        const routeCoords = routeGeoJSON.coordinates;

        // ── Route-based multi-city loading for smart suggestion ──
        const smartCitiesToLoad = detectRouteCities(routeCoords, start, end);
        if (smartCitiesToLoad.length > 0) {
            await loadMultiCityData(smartCitiesToLoad);
        }

        // Cumulative distances for precise progress calculation
        let cumulativeDistances = [0];
        let totalRouteDistanceCalc = 0;
        for (let i = 1; i < routeCoords.length; i++) {
            const p1 = routeCoords[i - 1];
            const p2 = routeCoords[i];
            const dist = getDistance(p1[1], p1[0], p2[1], p2[0]);
            totalRouteDistanceCalc += dist;
            cumulativeDistances.push(totalRouteDistanceCalc);
        }

        const totalRouteDistance = totalRouteDistanceCalc;

        // INITIAL FILTER BY SERVICE
        const stationsList = (typeof allStations !== 'undefined') ? allStations : ALL_STATIONS;
        let validStations = stationsList.filter(station => {
            if (station.services && station.services.length > 0) {
                return station.services.some(svc => String(svc).toLowerCase() === serviceType.toLowerCase());
            } else {
                return serviceType.toLowerCase() === 'ev';
            }
        });

        // MAP STATIONS TO ROUTE
        let mappedStations = [];
        validStations.forEach(station => {
            if (!station.lat || !station.lng) return;

            let minDistanceToRoute = Infinity;
            let closestRouteIndex = -1;

            for (let i = 0; i < routeCoords.length; i++) {
                const point = routeCoords[i];
                const dist = getDistance(station.lat, station.lng, point[1], point[0]); // [lng, lat]
                if (dist < minDistanceToRoute) {
                    minDistanceToRoute = dist;
                    closestRouteIndex = i;
                }
            }

            const positionAlongRoute = cumulativeDistances[closestRouteIndex];

            // REMOVE INVALID STATIONS
            // > 4km or behind start location (<=0.1 km distance traveled to filter out backwards)
            if (minDistanceToRoute <= 4 && positionAlongRoute > 0.1) {
                mappedStations.push({
                    ...station,
                    distanceToRoute: minDistanceToRoute,
                    positionAlongRoute: positionAlongRoute
                });
            }
        });

        if (mappedStations.length === 0) {
            showToast('No stations available along this route', 'error');
            return;
        }

        // CORRIDOR FILTER
        let corridorStations = [];
        const corridors = [0.2, 1.0, 2.0, 4.0];

        for (const limit of corridors) {
            corridorStations = mappedStations.filter(s => s.distanceToRoute <= limit);
            if (corridorStations.length > 0) {
                break; // stop expanding
            }
        }

        if (corridorStations.length === 0) {
            showToast('No stations available along this route', 'error');
            return;
        }

        // SORT BY ROUTE PROGRESS
        corridorStations.sort((a, b) => a.positionAlongRoute - b.positionAlongRoute);

        // BATTERY / FUEL DECISION ENGINE
        let bestStation = null;

        corridorStations.forEach(s => {
            s.progressRatio = s.positionAlongRoute / totalRouteDistance;
        });

        if (battery <= 20) {
            bestStation = corridorStations[0];
        } else if (battery >= 21 && battery <= 50) {
            // 30% - 60% of route
            const candidates = corridorStations.filter(s => s.progressRatio >= 0.30 && s.progressRatio <= 0.60);
            if (candidates.length > 0) {
                bestStation = candidates.find(s => s.distanceToRoute <= 1.0) || candidates[0];
            } else {
                bestStation = corridorStations[0]; // fallback early
            }
        } else if (battery >= 51 && battery <= 80) {
            // 60% - 85% of route
            const candidates = corridorStations.filter(s => s.progressRatio >= 0.60 && s.progressRatio <= 0.85);
            if (candidates.length > 0) {
                bestStation = candidates.find(s => s.distanceToRoute <= 0.2) || candidates[0];
            } else {
                bestStation = corridorStations[corridorStations.length - 1]; // fallback last
            }
        } else {
            // > 80: last available before destination
            bestStation = corridorStations[corridorStations.length - 1];
        }

        if (!bestStation) {
            bestStation = corridorStations[0];
        }

        // ── OFF-ROUTE EMERGENCY FALLBACK LOGIC ──
        let selectedOffRoute = null;
        let onRouteNearest = bestStation;

        if (battery <= 30) {
            let nearestOffRoute = null;
            let minOffRouteDist = Infinity;
            
            // Collect lat/lng strings of stations already in the mapped route
            const onRouteIds = new Set(mappedStations.map(s => `${s.lat},${s.lng}`));

            ALL_STATIONS.forEach(station => {
                if (!station.lat || !station.lng) return;

                // Service type filter
                let hasService = false;
                if (station.services && station.services.length > 0) {
                    hasService = station.services.some(svc => String(svc).toLowerCase() === serviceType.toLowerCase());
                } else {
                    hasService = serviceType.toLowerCase() === 'ev';
                }
                if (!hasService) return;

                // Exclude stations already in route list
                const stationId = `${station.lat},${station.lng}`;
                if (onRouteIds.has(stationId)) return;

                // Calculate distance from user current location (start)
                const distFromUser = getDistance(start.lat, start.lng, station.lat, station.lng);

                // Never suggest far off-route station (>5 km)
                if (distFromUser <= 5 && distFromUser < minOffRouteDist) {
                    minOffRouteDist = distFromUser;
                    nearestOffRoute = station;
                }
            });

            if (nearestOffRoute) {
                const distanceToOnRoute = onRouteNearest ? getDistance(start.lat, start.lng, onRouteNearest.lat, onRouteNearest.lng) : Infinity;

                if (battery <= 20) {
                    if (minOffRouteDist < distanceToOnRoute) {
                        selectedOffRoute = nearestOffRoute;
                    }
                } else if (battery <= 30) {
                    // Buffer: Allow off-route ONLY if significantly closer (e.g., at least 25% closer)
                    if (minOffRouteDist <= distanceToOnRoute * 0.75) {
                        selectedOffRoute = nearestOffRoute;
                    }
                }
            }
        }

        if (selectedOffRoute) {
            bestStation = selectedOffRoute;
            bestStation.isEmergencyOffRoute = true;
            // Mock route properties so downstream logic/UI doesn't break
            bestStation.distanceToRoute = getDistance(start.lat, start.lng, bestStation.lat, bestStation.lng);
            bestStation.progressRatio = 0;
            bestStation.positionAlongRoute = 0;
        }

        const bestStationEvaluation = evaluateStation(
            bestStation,
            { totalRouteDistance },
            battery
        );
        bestStation.smartEvaluation = bestStationEvaluation;
        bestStation.smartScore = bestStationEvaluation.score;
        bestStation.confidenceLevel = bestStationEvaluation.confidenceLevel;
        bestStation.confidenceBadge = bestStationEvaluation.confidenceBadge;
        bestStation.smartExplanation = bestStationEvaluation.explanation;

        let finalSelection = [bestStation];
        let alternatives = corridorStations.filter(s => s !== bestStation);
        finalSelection.push(...alternatives);

        // FINAL SELECTION - OUTPUT
        const primaryIsOffRoute = bestStation.isEmergencyOffRoute === true;

        finalSelection.forEach((station, index) => {
            const isBest = index === 0;
            const isOffRoute = station.isEmergencyOffRoute === true;
            
            // Secondary is the nearest on-route station (which will be at index 1), but ONLY if primary is off-route
            const isSecondary = primaryIsOffRoute && index === 1;

            const isOnRoute = !isBest && !isSecondary && !isOffRoute;

            const marker = createMarker(station, { isBest, isOffRoute, isOnRoute, isSecondary });

            if (isBest) {
                // ── XSS fix: escape all Firestore-sourced values before HTML insertion ──
                const safeName = escapeHTML(station.name);
                const rawLink = station.mapsLink;
                const validatedLink = safeLink(rawLink);
                const safeHref = escapeHTML(validatedLink);

                let badgesHTML = '';
                if (station.services) {
                    badgesHTML = station.services.map(svc => {
                        let className = 'popup-badge';
                        const type = String(svc).toLowerCase();
                        if (type === 'ev') className += ' EV';
                        else if (type === 'petrol') className += ' petrol';
                        else if (type === 'cng') className += ' CNG';
                        return `<span class="${className}">${escapeHTML(svc)}</span>`;
                    }).join('');
                }

                const evaluation = station.smartEvaluation;
                const confidenceHTML = evaluation ? `
                    <span class="smart-confidence-badge smart-confidence-${evaluation.confidenceClassName}" title="${escapeHTML(evaluation.confidenceLevel)}">
                      ${escapeHTML(evaluation.confidenceBadge)}
                    </span>
                ` : '';
                const explanationHTML = evaluation ? `
                    <div class="smart-explanation">
                      ${escapeHTML(evaluation.explanation)}
                    </div>
                ` : '';

                const topLabel = `<b style="color: #f59e0b; font-size: 0.9em; display:block; margin-bottom:5px;">⭐ Recommended Station</b>`;

                marker.bindPopup(`
                  <div class="station-popup">
                    ${topLabel}
                    <div class="popup-name">${safeName}</div>
                    <div style="margin-bottom: 12px;">
                      ${badgesHTML}
                    </div>
                    ${confidenceHTML}
                    <div style="font-size: 0.85em; color: #6b7280; margin-bottom: 12px;">
                      Distance off-route: ${station.distanceToRoute.toFixed(2)} km<br/>
                      Route Progress: ${(station.progressRatio * 100).toFixed(0)}%
                    </div>
                    ${explanationHTML}
                    <a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="popup-nav-btn" style="text-decoration:none; text-align:center;">
                      Navigate
                    </a>
                  </div>
                `);
            } // end if (isBest)

            marker.addTo(map);
            markers.push(marker);

            if (isBest) marker.openPopup();
        });

        document.getElementById('tripBtn').style.display = 'none';
        document.getElementById('smartEndBtn').style.display = 'inline-block';
        tripActive = true;

        const modal = document.getElementById('smart-suggestion-modal');
        if (modal) modal.classList.add('hidden');

        // Render legend
        const oldLegend = document.getElementById('smart-legend');
        if (oldLegend) oldLegend.remove();

        const legendHTML = `
        <div id="smart-legend" style="position: absolute; bottom: 20px; right: 20px; background: white; padding: 10px; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.2); z-index: 1000; font-size: 0.85em; font-family: 'Plus Jakarta Sans', sans-serif;">
          <div style="display:flex; align-items:center; margin-bottom: 6px;">
            <div style="width:12px; height:12px; background:#f59e0b; border-radius:50%; margin-right:8px; border:2px solid white; box-shadow:0 1px 2px rgba(0,0,0,0.3);"></div>
            <strong style="color: #374151;">Recommended</strong>
          </div>
          <div style="display:flex; align-items:center; margin-bottom: 6px;">
            <div style="width:12px; height:12px; background:#3b82f6; border-radius:50%; margin-right:8px; border:2px solid white; box-shadow:0 1px 2px rgba(0,0,0,0.3); transform: scale(1.1);"></div>
            <strong style="color: #3b82f6;">On Route Alternative</strong>
          </div>
          <div style="display:flex; align-items:center; margin-bottom: 6px;">
            <div style="width:12px; height:12px; background:#3b82f6; border-radius:50%; margin-right:8px; border:2px solid white; box-shadow:0 1px 2px rgba(0,0,0,0.3);"></div>
            <span style="color: #4b5563;">On Route</span>
          </div>
          <div style="display:flex; align-items:center;">
            <div style="width:12px; height:12px; background:#f97316; border-radius:50%; margin-right:8px; border:2px solid white; box-shadow:0 1px 2px rgba(0,0,0,0.3); opacity:0.8;"></div>
            <span style="color: #4b5563;">Nearby (Off Route)</span>
          </div>
        </div>
        `;
        document.getElementById('map').insertAdjacentHTML('beforeend', legendHTML);

        showToast('Smart Suggestion applied!', 'success');

    } catch (err) {
        console.warn(err);
        showToast(err.message || "An error occurred", 'error');
    }
}

function endSmartTrip() {
    tripActive = false;

    const tripBtn = document.getElementById('tripBtn');
    if (tripBtn) tripBtn.style.display = 'inline-block';

    const smartEndBtn = document.getElementById('smartEndBtn');
    if (smartEndBtn) smartEndBtn.style.display = 'none';

    if (window.routeLayer) {
        map.removeLayer(window.routeLayer);
        window.routeLayer = null;
    }

    markers.forEach(m => map.removeLayer(m));
    markers = [];

    // Revert to single city mode
    const center = CITY_CENTERS[selectedCity] || CITY_CENTERS.Nashik;
    map.setView([center.lat, center.lng], 12);
    if (selectedCity) {
        loadCityData(selectedCity);
    } else {
        updateMapSubtitle();
        clearMarkers();
    }
}

// ── Require Login Gate ──
function requireLogin() {
    if (isUserLoggedIn) return true;

    const loginModal = document.getElementById("login-prompt-modal");
    if (loginModal) {
        loginModal.classList.remove("hidden");
    } else {
        alert("Please login to use this feature");
    }
    return false;
}

document.addEventListener('DOMContentLoaded', () => {
    const checkLeaflet = setInterval(() => {
        if (typeof L !== 'undefined') {
            clearInterval(checkLeaflet);
            initMap();
            bindEvents();
            initCitySelector();
        }
    }, 100);
});

// ── City Selector UI initialization ──
function initCitySelector() {
    document.querySelectorAll('.city-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const city = btn.dataset.city;
            if (city && city !== selectedCity) {
                // If a trip is active, end it first
                if (tripActive) endTrip();
                switchCity(city);
            }
        });
    });
}
