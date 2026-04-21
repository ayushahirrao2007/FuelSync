import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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

let map            = null;
let markerGroup    = null;
let userMarker     = null;
let activeFilter   = 'all';
let toastTimer     = null;
let ALL_STATIONS   = [];
let smartTripActive = false;
let loginInProgress = false;
let selectedService = null;

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

    loadStations();
}

async function loadStations() {
    try {
        const querySnapshot = await getDocs(collection(db, "stations"));
        ALL_STATIONS = [];
        querySnapshot.forEach((doc) => {
            ALL_STATIONS.push(doc.data());
        });

        const loader = document.getElementById('map-loader');
        if (loader) loader.classList.add('hidden');

        allStations = ALL_STATIONS;
        clearMarkers();
    } catch (error) {
        console.error("Firestore fetch failed:", error);
    }
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

function getStationIcon(services) {
    let color = '#9ca3af'; // gray default
    if (services && services.length > 0) {
        const s = services.map(x => String(x).toLowerCase());
        if (s.includes('ev')) color = '#4CAF50';
        else if (s.includes('petrol')) color = '#ef4444';
        else if (s.includes('cng')) color = '#3b82f6';
    }
    
    return L.divIcon({
        className: 'custom-station-icon',
        html: `<div style="background-color: ${color}; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -11]
    });
}

function createMarker(station) {
  const icon = getStationIcon(station.services);
  const marker = L.marker([station.lat, station.lng], { icon });

  let badgesHTML = '';
  if (station.services) {
      badgesHTML = station.services.map(svc => {
          let className = 'popup-badge';
          const type = String(svc).toLowerCase();
          if (type === 'ev') className += ' EV';
          if (type === 'petrol') className += ' petrol';
          if (type === 'cng') className += ' CNG';
          return `<span class="${className}">${svc}</span>`;
      }).join('');
  }

  marker.bindPopup(`
    <div class="station-popup">
      <div class="popup-name">${station.name}</div>
      <div style="margin-bottom: 15px;">
        ${badgesHTML}
      </div>
      <a href="${station.mapsLink}" target="_blank" class="popup-nav-btn" style="text-decoration:none; text-align:center;">
        Navigate
      </a>
    </div>
  `);

  return marker;
}

window.handleNavigation = function(lat, lng) {
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
    const labelMap   = { all: 'All Stations – Nashik', EV: 'EV Charging – Nashik', petrol: 'Petrol Pumps – Nashik', CNG: 'CNG Stations – Nashik' };
    if (subtitleEl) subtitleEl.textContent = labelMap[type] || 'Nashik';
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

    setTextContent('ev-count',     counts.EV);
    setTextContent('petrol-count', counts.petrol);
    setTextContent('cng-count',    counts.CNG);

    setTextContent('stat-total',  visibleStations.length);
    setTextContent('stat-ev',     counts.EV);
    setTextContent('stat-petrol', counts.petrol);
    setTextContent('stat-cng',    counts.CNG);
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
                iconSize:   [20, 20],
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
    const toast   = document.getElementById('locate-toast');
    const msgEl   = document.getElementById('toast-msg');
    if (!toast || !msgEl) return;

    msgEl.textContent = message;

    toast.style.background =
        type === 'error'   ? '#dc2626' :
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

function getDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
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
      allStations = ALL_STATIONS;
      
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
      
      function getStationDistances(routeCoords, station, userLocation) {
        let minRouteDist = Infinity;
        for (let i = 0; i < routeCoords.length; i += 10) {
          const point = routeCoords[i];
          const dist = getDistance(
            station.lat,
            station.lng,
            point[1], // lat is index 1
            point[0]  // lng is index 0
          );
          if (dist < minRouteDist) {
            minRouteDist = dist;
          }
        }
        const userDist = getDistance(
          userLocation.lat,
          userLocation.lng,
          station.lat,
          station.lng
        );
        return { routeDist: minRouteDist, userDist };
      }

      function getRouteStations(routeCoords, stations, selectedService, userLocation) {
        const result = [];
        stations.forEach(station => {
          let hasService = false;
          if (station.services && station.services.length > 0) {
              hasService = station.services.some(svc => String(svc).toLowerCase() === selectedService.toLowerCase());
          } else {
              hasService = selectedService.toLowerCase() === 'ev';
          }
          if (!hasService) return;

          const { routeDist, userDist } = getStationDistances(
            routeCoords,
            station,
            userLocation
          );

          if (routeDist <= 4 && userDist <= 15) {
            result.push({
              ...station,
              routeDist,
              userDist
            });
          }
        });
        return result;
      }

      function sortStations(stations) {
        return stations.sort((a, b) => {
          if (a.routeDist !== b.routeDist) {
            return a.routeDist - b.routeDist;
          }
          return a.userDist - b.userDist;
        });
      }

      function getFinalStations(routeCoords, allStations, selectedService, userLocation) {
        let stations = getRouteStations(
          routeCoords,
          allStations,
          selectedService,
          userLocation
        );

        if (stations.length === 0) {
          const nearest = findNearest(userLocation, allStations.filter(s => {
             if (s.services && s.services.length > 0) {
                 return s.services.some(svc => String(svc).toLowerCase() === selectedService.toLowerCase());
             } else {
                 return selectedService.toLowerCase() === 'ev';
             }
          }));
          return nearest ? [nearest] : [];
        }

        stations = sortStations(stations);
        return stations.slice(0, 4);
      }

      const filteredStations = getFinalStations(
        routeCoords,
        allStations,
        serviceType,
        start
      );

      filteredStations.forEach(station => {
          const marker = createMarker(station).addTo(map);
          markers.push(marker);
      });

      showToast(`Found ${filteredStations.length} stations along the route.`, 'success');
      
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
  tripActive = false;

  document.getElementById("tripBtn").innerText = "Plan Your Trip";

  // remove route
  if (window.routeLayer) {
    map.removeLayer(window.routeLayer);
  }

  // remove markers
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  // reset map
  map.setView([19.9975, 73.7898], 12);
  
  // optionally re-render normal stations via the main filtering mechanism if exists
  clearMarkers();
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
                iconSize:   [20, 20],
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
        selectedService = null; 
        if (window.routeLayer) {
            map.removeLayer(window.routeLayer);
            window.routeLayer = null;
        }
        clearMarkers(); 
    };

    const closeNearbyErrorBtn = document.getElementById("close-nearby-error-btn");
    const okNearbyErrorBtn = document.getElementById("ok-nearby-error-btn");
    const nearbyErrorModal = document.getElementById("nearby-error-modal");

    if (closeNearbyErrorBtn) closeNearbyErrorBtn.onclick = () => { if (nearbyErrorModal) nearbyErrorModal.classList.add("hidden"); };
    if (okNearbyErrorBtn) okNearbyErrorBtn.onclick = () => { if (nearbyErrorModal) nearbyErrorModal.classList.add("hidden"); };

    const locateBtn = document.getElementById('locate-me-btn');
    if (locateBtn) locateBtn.addEventListener('click', locateUser);

    const nearbyBtn = document.getElementById('btn-nearby');
    if (nearbyBtn) nearbyBtn.addEventListener('click', handleNearbyStation);

    const planTripBtn = document.getElementById('tripBtn');
    const planTripModal = document.getElementById('plan-trip-modal');
    const closeTripModalBtn = document.getElementById('close-modal-btn');
    const submitTripBtn = document.getElementById('submit-trip-btn');
    const startTypeRadios = document.querySelectorAll('input[name="start-type"]');
    const startInput = document.getElementById('trip-start-input');
    const destInput = document.getElementById('trip-dest-input');

    if (planTripBtn) {
        planTripBtn.addEventListener('click', toggleTrip);
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
            if (map) map.flyTo([19.9975, 73.7898], 13, { duration: 1.2 });
            showToast('Filters reset.', 'info', 2000);
            
            // if trip is active end it
            if (tripActive) endTrip();
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
        smartSuggestBtn.addEventListener('click', openSmartSuggestionForm);
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

    onAuthStateChanged(auth, (user) => {
      const loginBtn = document.getElementById("loginBtn");
      const profileBox = document.getElementById("profileBox");
      const userName = document.getElementById("userName");
      const userPhoto = document.getElementById("userPhoto");

      if (!loginBtn || !profileBox || !userName || !userPhoto) return;

      if (user) {
        loginBtn.style.display = "none";
        profileBox.style.display = "flex";
        userName.innerText = user.displayName;
        userPhoto.src = user.photoURL;
      } else {
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

        let finalSelection = [bestStation];
        let alternatives = corridorStations.filter(s => s !== bestStation).slice(0, 2);
        finalSelection.push(...alternatives);

        // FINAL SELECTION - OUTPUT
        finalSelection.forEach((station, index) => {
            const isBest = index === 0;
            const marker = createMarker(station);
            
            if (isBest) {
                let badgesHTML = '';
                if (station.services) {
                    badgesHTML = station.services.map(svc => {
                        let className = 'popup-badge';
                        const type = String(svc).toLowerCase();
                        if (type === 'ev') className += ' EV';
                        if (type === 'petrol') className += ' petrol';
                        if (type === 'cng') className += ' CNG';
                        return `<span class="${className}">${svc}</span>`;
                    }).join('');
                }

                marker.bindPopup(`
                  <div class="station-popup">
                    <b style="color: #8b5cf6; font-size: 0.9em; display:block; margin-bottom:5px;">⭐ BEST MATCH</b>
                    <div class="popup-name">${station.name}</div>
                    <div style="margin-bottom: 12px;">
                      ${badgesHTML}
                    </div>
                    <div style="font-size: 0.85em; color: #6b7280; margin-bottom: 12px;">
                      Distance off-route: ${station.distanceToRoute.toFixed(2)} km<br/>
                      Route Progress: ${(station.progressRatio * 100).toFixed(0)}%
                    </div>
                    <a href="${station.mapsLink}" target="_blank" class="popup-nav-btn" style="text-decoration:none; text-align:center;">
                      Navigate
                    </a>
                  </div>
                `);
            }
            marker.addTo(map);
            markers.push(marker);
            
            if (isBest) marker.openPopup();
        });

        document.getElementById('tripBtn').style.display = 'none';
        document.getElementById('smartEndBtn').style.display = 'inline-block';
        tripActive = true;

        const modal = document.getElementById('smart-suggestion-modal');
        if (modal) modal.classList.add('hidden');
        
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

    map.setView([19.9975, 73.7898], 12);
    clearMarkers();
}

document.addEventListener('DOMContentLoaded', () => {
    const checkLeaflet = setInterval(() => {
        if (typeof L !== 'undefined') {
            clearInterval(checkLeaflet);
            initMap();
            bindEvents();
        }
    }, 100);
});
