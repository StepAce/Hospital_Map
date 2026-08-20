// map.js — логика карты и маршрутов
'use strict';

// === СОСТОЯНИЕ ===
var deferredPrompt = null;
var appData = null;
var scale = 1;
var allNodes = {};
var graph = {};
// Стартовая точка (откуда идём)
var startPoint = null;  // { id, type, x, y, name, ... }
// Целевая точка (куда идём)
var endPoint = null;    // { id, type, x, y, name, buildingId, deptId?, ... }
var buildingMarkerEls = {};
var startPinEl = null;
var labelEls = [];
var metersPerPixel = 0.25;
var PIN_OFFSET_Y = 8;
var PIN_OFFSET_X = 0;
var scrollContainer = null;
var mapSizes = null;
var hintLabel = null;
var hintEmoji = null;
var hintReset = null;
// Настройка анимации маршрута: true — бесконечный бегущий пунктир, false — статичный пунктир после прорисовки
var ANIMATE_ROUTE_INFINITE = true;

// Настройки визуального скругления линии маршрута
var ROUTE_LINE_CONFIG = {
    curveTension: 0.3,
    lineJoin: 'round',
    lineCap: 'round'
};
console.log('ROUTE_LINE_CONFIG:', ROUTE_LINE_CONFIG);
// GPS-привязка: опорная точка и ID трекинга
var geoTransform = null;
var gpsWatchId = null;

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (нужны до buildGraph) ===
// getDeptObjects — критический путь: вызывается в buildGraph(), findDeptById(), renderLabels(), handleLabelTarget()
function getDeptObjects(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return [];
}

// === ЗАГРУЗКА ДАННЫХ ===
async function loadData() {
    // Пробуем свежую версию, при ошибке — из кэша SW
    var resp;
    try {
        resp = await fetch('data.json?v=' + Date.now());
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
    } catch(e1) {
        try {
            resp = await fetch('data.json');
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
        } catch(e2) {
            throw new Error('Не удалось загрузить data.json');
        }
    }
    appData = await resp.json();
    metersPerPixel = appData.config.metersPerPixel;
    console.log('Успешно загружен appData:', appData);
}

// Авто-генерация стартовых точек из массива зданий и отделений
function autoGenerateStartPoints() {
    if (!appData.buildings || !appData.buildings.length) return;
    if (!appData.startPoints || !appData.startPoints.length) {
        appData.startPoints = [];
        appData.buildings.forEach(function(b) {
            // QR-точка здания
            appData.startPoints.push({
                id: 'qr_' + b.id,
                name: 'QR ' + b.name,
                x: b.x,
                y: b.y
            });
            // QR-точки для каждого отделения внутри здания
            var depts = getDeptObjects(b.departments);
            depts.forEach(function(d) {
                if (d.x === undefined || d.y === undefined) return;
                appData.startPoints.push({
                    id: 'qr_' + d.id,
                    name: d.name.replace(/\n/g, ' '),
                    x: d.x,
                    y: d.y
                });
            });
        });
        console.log('Сгенерировано стартовых точек:', appData.startPoints.length);
        buildGraph();
        console.log('Граф перестроен с ' + appData.startPoints.length + ' startPoints и авто-привязками');
    }
}

// === GPS: ОПОРНАЯ ТОЧКА И ПЕРЕВОД КООРДИНАТ ===
function computeGeoTransform() {
    if (!appData || !appData.geoRef || !appData.geoRef.length) return;
    var ref = appData.geoRef[0];
    geoTransform = { refLat: ref.lat, refLng: ref.lng, refX: ref.x, refY: ref.y };
}

function gpsToPixel(lat, lng) {
    if (!geoTransform) return null;
    var cosLat = Math.cos(geoTransform.refLat * Math.PI / 180);
    var dLat = lat - geoTransform.refLat;
    var dLng = lng - geoTransform.refLng;
    var deltaXMeters = dLng * 111132 * cosLat;
    var deltaYMeters = dLat * 111132;
    var deltaXPx = deltaXMeters / metersPerPixel;
    var deltaYPx = deltaYMeters / metersPerPixel;
    return { x: geoTransform.refX + deltaXPx, y: geoTransform.refY - deltaYPx };
}

function findNearestLocation(lat, lng) {
    var px, py;
    var pixel = gpsToPixel(lat, lng);
    if (pixel) { px = pixel.x; py = pixel.y; }
    else { px = lng * 1000; py = lat * 1000; }

    var best = null, bestDist = Infinity;
    if (appData.startPoints) appData.startPoints.forEach(function(sp) {
        var d = Math.hypot(sp.x - px, sp.y - py);
        if (d < bestDist) { bestDist = d; best = { type: 'start', id: sp.id, name: sp.name }; }
    });
    if (appData.buildings) appData.buildings.forEach(function(b) {
        var depts = getDeptObjects(b.departments);
        depts.forEach(function(d) {
            if (d.x === undefined || d.y === undefined) return;
            var d2 = Math.hypot(d.x - px, d.y - py);
            if (d2 < bestDist) { bestDist = d2; best = { type: 'dept', id: d.id, name: d.name }; }
        });
    });
    if (best) {
        setStartPoint(best.type, best.id);
        alert('\u041E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u043E: ' + best.name + '. \u0412\u044B \u0437\u0434\u0435\u0441\u044C?');
    }
}

function requestGPS() {
    if (!navigator.geolocation) return;
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
        return;
    }
    gpsWatchId = navigator.geolocation.watchPosition(
        function(pos) {
            var pixel = gpsToPixel(pos.coords.latitude, pos.coords.longitude);
            if (pixel && startPoint) {
                var d = Math.hypot(pixel.x - startPoint.x, pixel.y - startPoint.y);
                if (d > 5) findNearestLocation(pos.coords.latitude, pos.coords.longitude);
            } else {
                findNearestLocation(pos.coords.latitude, pos.coords.longitude);
            }
        },
        function(err) { alert('\u041E\u0448\u0438\u0431\u043A\u0430 GPS: ' + (err.message || '\u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D')); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

// === ПОСТРОЕНИЕ ГРАФА ===
function buildGraph() {
    allNodes = {};
    graph = {};

    appData.buildings.forEach(function(b) {
        var key = 'B' + b.id;
        allNodes[key] = { x: b.x, y: b.y, name: b.name, isBuilding: true, buildingId: b.id };
        graph[key] = {};
    });

    appData.startPoints.forEach(function(s) {
        allNodes[s.id] = { x: s.x, y: s.y, name: s.name, isStart: true };
        graph[s.id] = {};
    });

    var addEdge = function(a, b) {
        if (!allNodes[a] || !allNodes[b]) return;
        var dx = allNodes[a].x - allNodes[b].x;
        var dy = allNodes[a].y - allNodes[b].y;
        var dist = Math.hypot(dx, dy);
        graph[a][b] = dist;
        graph[b][a] = dist;
    };

    appData.buildings.forEach(function(b) {
        var depts = getDeptObjects(b.departments);
        depts.forEach(function(d) {
            var deptKey = 'D' + d.id;
            allNodes[deptKey] = { x: d.x, y: d.y, name: d.name, isDept: true, buildingId: b.id, deptId: d.id };
            graph[deptKey] = {};

            var wpts = d.waypoints;
            if (wpts && wpts.length > 0) {
                wpts.forEach(function(w) {
                    if (!allNodes[w.id]) {
                        allNodes[w.id] = { x: w.x, y: w.y, isWaypoint: true };
                        graph[w.id] = {};
                    }
                });
                for (var i = 0; i < wpts.length - 1; i++) {
                    addEdge(wpts[i].id, wpts[i + 1].id);
                }

                addEdge(wpts[wpts.length - 1].id, deptKey);

                var firstWpt = wpts[0].id;
                var hasEdge = false;
                var edges = (appData.graph && appData.graph.edges) ? appData.graph.edges : [];
                for (var e = 0; e < edges.length; e++) {
                    var edge = edges[e];
                    var f = Array.isArray(edge) ? edge[0] : edge.from;
                    var t = Array.isArray(edge) ? edge[1] : edge.to;
                    if (f === firstWpt || t === firstWpt) { hasEdge = true; break; }
                }

                if (!hasEdge && appData.startPoints && appData.startPoints.length) {
                    addEdge(appData.startPoints[0].id, firstWpt);
                }
            }
        });
    });

    if (appData.waypoints) {
        appData.waypoints.forEach(function(w) {
            if (!allNodes[w.id]) {
                allNodes[w.id] = { x: w.x, y: w.y, isWaypoint: true };
                graph[w.id] = {};
            }
        });
    }

    if (appData.graph && appData.graph.edges) {
        appData.graph.edges.forEach(function(e) {
            // Поддержка двух форматов: массивы ["A","B"] и объекты {from:"A",to:"B"}
            if (Array.isArray(e)) {
                addEdge(e[0], e[1]);
            } else if (e.from && e.to) {
                addEdge(e.from, e.to);
            }
        });
    }

    // Авто-привязка каждой стартовой точки к графу дорог
    if (appData.startPoints) {
        appData.startPoints.forEach(function(sp) {
            var targets = [], method = '';
            if (sp.entryW) {
                if (Array.isArray(sp.entryW)) {
                    targets = sp.entryW.filter(function(wId) { return allNodes[wId] && allNodes[wId].isWaypoint; });
                    method = 'entryW[' + targets.length + ']';
                } else if (allNodes[sp.entryW] && allNodes[sp.entryW].isWaypoint) {
                    targets = [sp.entryW];
                    method = 'entryW';
                }
            }
            if (!targets.length) {
                var bestW = null, bestD = Infinity;
                Object.keys(allNodes).forEach(function(k) {
                    var n = allNodes[k];
                    if (!n.isWaypoint) return;
                    var d = Math.hypot(n.x - sp.x, n.y - sp.y);
                    if (d < bestD) { bestD = d; bestW = k; }
                });
                if (bestW) { targets = [bestW]; method = 'nearest (' + (bestD * (appData.config.metersPerPixel || 0.25)).toFixed(1) + 'm)'; }
            }
            targets.forEach(function(wId) {
                addEdge(sp.id, wId);
            });
            if (targets.length) {
                console.log('Привязка ' + (sp.name || sp.id) + ': через ' + method + ' -> ' + targets.join(', '));
            }
        });
    }

    console.log('ИТОГОВЫЙ ГРАФ СВЯЗЕЙ:', graph);
    console.log('Связи для qr_1001:', graph['qr_1001']);
    console.log('Связи для qr_101:', graph['qr_101']);
    console.log('Всего startPoints:', appData.startPoints ? appData.startPoints.length : 0);
    console.log('Всего waypoints в allNodes:', Object.keys(allNodes).filter(function(k) { return allNodes[k].isWaypoint; }).length);
}

// === АЛГОРИТМ ДЕЙКСТРЫ ===
function findPath(fromKey, toKey) {
    if (!allNodes[fromKey] || !allNodes[toKey]) {
        console.warn('findPath: узел не найден', { from: fromKey, to: toKey, fromExists: !!allNodes[fromKey], toExists: !!allNodes[toKey] });
        return null;
    }
    var dist = {}, prev = {};
    Object.keys(allNodes).forEach(function(k) { dist[k] = Infinity; });
    dist[fromKey] = 0;
    var unvisited = Object.keys(allNodes).slice();
    while (unvisited.length) {
        var minIdx = 0;
        for (var i = 1; i < unvisited.length; i++) {
            if (dist[unvisited[i]] < dist[unvisited[minIdx]]) minIdx = i;
        }
        var current = unvisited[minIdx];
        unvisited.splice(minIdx, 1);
        if (dist[current] === Infinity || current === toKey) break;
        var neighbors = graph[current];
        if (neighbors) {
            Object.keys(neighbors).forEach(function(nb) {
                var alt = dist[current] + neighbors[nb];
                if (alt < dist[nb]) { dist[nb] = alt; prev[nb] = current; }
            });
        }
    }
    if (dist[toKey] === Infinity) {
        console.warn('findPath: путь не найден (нет рёбер между узлами)', { from: fromKey, to: toKey, graphFrom: graph[fromKey], graphTo: graph[toKey] });
        return null;
    }
    var path = [toKey];
    var cur = toKey;
    while (cur !== fromKey) { cur = prev[cur]; path.unshift(cur); }
    return { nodes: path, distance: dist[toKey] };
}

function findNearestWaypoint(x, y) {
    var best = null, bestDist = Infinity;
    Object.keys(allNodes).forEach(function(id) {
        var n = allNodes[id];
        if (!n) return;
        var dx = n.x - x, dy = n.y - y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDist) { bestDist = d; best = id; }
    });
    return best;
}

function findPathSnapped(fromX, fromY, toX, toY) {
    var fromW = findNearestWaypoint(fromX, fromY);
    var toW = findNearestWaypoint(toX, toY);
    if (!fromW || !toW) return null;
    var result = findPath(fromW, toW);
    if (!result) return null;
    result.nodes.unshift('_from');
    result.nodes.push('_to');
    allNodes['_from'] = { x: fromX, y: fromY, isVirtual: true };
    allNodes['_to'] = { x: toX, y: toY, isVirtual: true };
    return result;
}

// === ИНИЦИАЛИЗАЦИЯ КАРТЫ ===
function initMap() {
    var cfg = appData.config;
    var img = document.getElementById('mapImage');
    var wrapper = document.getElementById('mapWrapper');
    scrollContainer = document.getElementById('mapScrollContainer');

    return new Promise(function(resolve, reject) {
        img.onload = function() {
            recalculateLayout();
            resolve();
        };
        img.onerror = function() {
            reject(new Error('Не удалось загрузить изображение карты'));
        };
        img.src = (cfg && cfg.mapImage) || 'hospital-map.webp';
    });
}

// === ЛОГИКА МАСШТАБИРОВАНИЯ ===
function applyScale(forceWidthMode) {
    var wrapper = document.getElementById('mapWrapper');
    var img = document.getElementById('mapImage');
    
    var wrapperWidth = wrapper.clientWidth;
    var naturalWidth = img.naturalWidth;
    var naturalHeight = img.naturalHeight;
    
    if (!startPoint) {
        scale = 1;
        mapSizes = { totalWidth: naturalWidth, totalHeight: naturalHeight };
        wrapper.style.height = naturalHeight + 'px';
        img.style.width = naturalWidth + 'px';
        img.style.height = naturalHeight + 'px';
        var ml = document.getElementById('markersLayer');
        ml.style.width = naturalWidth + 'px';
        ml.style.height = naturalHeight + 'px';
        return;
    }
    var sp = allNodes[startPoint.id];
    var anchorX = sp ? sp.x * scale : 0;

    var totalWidth, totalHeight;
    
    if (forceWidthMode) {
        scale = wrapperWidth / naturalWidth;
        totalWidth = wrapperWidth;
        totalHeight = naturalHeight * scale;
    } else {
        var availableHeight = getAvailableHeight();
        scale = availableHeight / naturalHeight;
        totalWidth = naturalWidth * scale;
        totalHeight = availableHeight;
    }

    mapSizes = { totalWidth: totalWidth, totalHeight: totalHeight };

    wrapper.style.height = totalHeight + 'px';
    img.style.width = totalWidth + 'px';
    img.style.height = totalHeight + 'px';

    var markersLayer = document.getElementById('markersLayer');
    markersLayer.style.width = totalWidth + 'px';
    markersLayer.style.height = totalHeight + 'px';
}

function getAvailableHeight() {
    var viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    var header = document.querySelector('.header');
    var hintPanel = document.querySelector('.hint-panel');
    var buildingsPanel = document.getElementById('buildingsPanel');
    
    var usedHeight = 0;
    if (header) usedHeight += header.offsetHeight;
    if (hintPanel) usedHeight += hintPanel.offsetHeight;
    if (buildingsPanel) {
        usedHeight += buildingsPanel.offsetHeight;
    }
    
    return viewportHeight - usedHeight;
}

function repositionMarkers() {
    if (startPinEl && startPoint) {
        startPinEl.style.left = (startPoint.x * scale + PIN_OFFSET_X) + 'px';
        startPinEl.style.top = (startPoint.y * scale - PIN_OFFSET_Y) + 'px';
    }
    labelEls.forEach(function(item) {
        var lbl = item.data;
        item.el.style.left = (lbl.dot_x * scale) + 'px';
        item.el.style.top = (lbl.dot_y * scale) + 'px';
    });
    Object.keys(buildingMarkerEls).forEach(function(bid) {
        var b = findBuildingById(parseInt(bid));
        if (!b) return;
        var dot = buildingMarkerEls[bid];
        dot.style.left = (b.x * scale) + 'px';
        dot.style.top = (b.y * scale) + 'px';
    });
}

function updateActiveStartLabel() {
    labelEls.forEach(function(item) {
        item.el.classList.remove('is-active-start');
    });
    if (!startPoint) return;
    var deptId = null;
    if (startPoint.type === 'dept') {
        deptId = startPoint.deptId;
    } else if (startPoint.type === 'start') {
        var m = String(startPoint.id).match(/\d+$/);
        if (m) deptId = parseInt(m[0], 10);
    }
    if (deptId === null) return;
    labelEls.forEach(function(item) {
        if (item.data.target === String(deptId)) {
            item.el.classList.add('is-active-start');
        }
    });
}

function findBuildingById(id) {
    return appData.buildings.find(function(b) { return b.id === id; });
}

// === ОТРИСОВКА МАРКЕРОВ ===
function renderMarkers() {
    var markersLayer = document.getElementById('markersLayer');

    var container = document.createElement('div');
    container.className = 'pin-container';
    if (startPoint) {
        container.style.left = (startPoint.x * scale + PIN_OFFSET_X) + 'px';
        container.style.top = (startPoint.y * scale - PIN_OFFSET_Y) + 'px';
    }

    var pinWrap = document.createElement('div');
    pinWrap.className = 'pin';
    pinWrap.innerHTML = '<svg viewBox="0 0 50 68" xmlns="http://www.w3.org/2000/svg"><defs><mask id="hole"><rect width="50" height="68" fill="white"/><circle cx="25" cy="25" r="8" fill="black"/></mask></defs><path d="M25 2 C12 2 2 12 2 25 C2 40 25 66 25 66 C25 66 48 40 48 25 C48 12 38 2 25 2 Z" fill="#E53935" stroke="white" stroke-width="2" stroke-linejoin="round" mask="url(#hole)"/><circle cx="25" cy="25" r="9" fill="none" stroke="white" stroke-width="2"/></svg>';
    container.appendChild(pinWrap);

    markersLayer.appendChild(container);
    startPinEl = container;
}

function findDeptById(deptId) {
    if (!appData || !appData.buildings) return null;
    for (var i = 0; i < appData.buildings.length; i++) {
        var b = appData.buildings[i];
        var depts = getDeptObjects(b.departments);
        for (var j = 0; j < depts.length; j++) {
            if (depts[j].id === deptId) return depts[j];
        }
    }
    return null;
}

function renderLabels() {
    var layer = document.getElementById('markersLayer');
    labelEls = [];

    var generatedLabels = [];

    if (appData.buildings) {
        appData.buildings.forEach(function(b) {
            var depts = getDeptObjects(b.departments);
            depts.forEach(function(d) {
                if (d.x === undefined || d.y === undefined) return;
                var lx = (d.label_x !== undefined) ? d.label_x : (d.x + 36);
                var ly = (d.label_y !== undefined) ? d.label_y : (d.y - 20);
                generatedLabels.push({
                    id: 'label_dept_' + d.id,
                    text: d.name,
                    label_x: lx,
                    label_y: ly,
                    dot_x: d.x,
                    dot_y: d.y,
                    target: String(d.id),
                    align: d.align || 'top-left'
                });
            });
        });
    }

    generatedLabels.forEach(function(lbl) {
        // Контейнер по координатам ТОЧКИ (dot_x, dot_y)
        var container = document.createElement('div');
        container.className = 'start-label';
        container.style.position = 'absolute';
        container.style.left = (lbl.dot_x * scale) + 'px';
        container.style.top = (lbl.dot_y * scale) + 'px';
        container.style.zIndex = '20';
        container.style.pointerEvents = 'auto';
        container.style.cursor = 'pointer';

        // Кружок в центре контейнера (0,0)
        var dot = document.createElement('span');
        dot.className = 'label-dot-inner';
        container.appendChild(dot);

        var badge = document.createElement('span');
        badge.className = 'label-badge';
        var formattedText = lbl.text.replace(/\s*(\d+\s*этаж)/i, '\n$1');
        badge.textContent = formattedText;
        badge.style.position = 'absolute';
        badge.classList.add('badge-align-' + lbl.align);
        container.appendChild(badge);

        if (lbl.target) {
            container.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                handleLabelTarget(lbl.target);
            });
            dot.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                handleLabelTarget(lbl.target);
            });
            badge.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                handleLabelTarget(lbl.target);
            });
        }

        layer.appendChild(container);
        labelEls.push({ el: container, data: lbl });
    });
}

function handleLabelTarget(target) {
    console.log('handleLabelTarget вызван с target:', target);

    var deptId;
    if (typeof target === 'object' && target !== null) {
        if (target.deptId !== undefined) {
            deptId = parseInt(target.deptId);
        } else if (target.id !== undefined) {
            deptId = parseInt(target.id);
        }
    } else {
        deptId = parseInt(target);
    }

    if (!isNaN(deptId)) {
        setEndPoint('dept', deptId);
    }
}

function findBuildingByDeptId(deptId) {
    if (!appData || !appData.buildings) return null;
    for (var i = 0; i < appData.buildings.length; i++) {
        var b = appData.buildings[i];
        var depts = getDeptObjects(b.departments);
        for (var j = 0; j < depts.length; j++) {
            if (depts[j].id === deptId) return b;
        }
    }
    return null;
}

function renderBuildingMarkers() {
    var layer = document.getElementById('markersLayer');
    buildingMarkerEls = {};
    appData.buildings.forEach(function(b) {
        var dot = document.createElement('div');
        dot.className = 'building-marker';
        dot.textContent = b.id;
        dot.style.left = (b.x * scale) + 'px';
        dot.style.top = (b.y * scale) + 'px';
        // dot.addEventListener('click', function() { openPanelForBuilding(b.id); });
        layer.appendChild(dot);
        buildingMarkerEls[b.id] = dot;
    });
}

// === УСТАНОВКА ТОЧЕК МАРШРУТА ===

// Установка стартовой точки (откуда идём)
function setStartPoint(type, id) {
    // КПП всегда привязывается к QR-точке отделения 1001
    var numericId = parseInt(id);
    if (id === 'qr_gate' || id === 'D1001' || numericId === 1001) {
        type = 'start';
        id = 'qr_1001';
    }
    // Администрация всегда привязывается к QR-точке отделения 102
    if (id === 'qr_admin' || id === 'D102' || numericId === 102) {
        type = 'start';
        id = 'qr_102';
    }
    var sp = null;
    if (type === 'start') {
        sp = appData.startPoints.find(function(p) { return p.id === String(id); });
        if (sp) sp = { id: sp.id, type: 'start', x: sp.x, y: sp.y, name: sp.name };
    } else if (type === 'dept') {
        sp = findDeptById(parseInt(id));
        if (sp) sp = { id: 'D' + sp.id, type: 'dept', x: sp.x, y: sp.y, name: sp.name, buildingId: findBuildingByDeptId(sp.id).id, deptId: sp.id };
    } else if (type === 'building') {
        var b = findBuildingById(parseInt(id));
        if (b) sp = { id: 'B' + b.id, type: 'building', x: b.x, y: b.y, name: b.name, buildingId: b.id };
    }
    if (!sp) {
        var defaultSp = appData.startPoints[0];
        if (defaultSp) {
            sp = { id: defaultSp.id, type: 'start', x: defaultSp.x, y: defaultSp.y, name: defaultSp.name };
            console.warn('Точка не найдена (' + type + '/' + id + '). Выбрана точка по умолчанию: ' + defaultSp.name);
        } else {
            return;
        }
    }
    startPoint = sp;
    // Сохраняем в localStorage для восстановления при следующем запуске
    try {
        localStorage.setItem('savedStartPoint', JSON.stringify({
            type: startPoint.type,
            id: startPoint.type === 'dept' ? startPoint.deptId : startPoint.id
        }));
    } catch(e) { /* localStorage недоступен */ }
    updateActiveStartLabel();
    repositionMarkers();
    centerOnStartPoint();
    updateDeptItemsActive();
    updateBuildingsListSelection();
    updateHint();
    // При смене старта — сбросить маршрут к цели, пользователь выбирает новую
    clearRoute();
}

// Установка целевой точки (куда идём)
function setEndPoint(type, id) {
    var ep = null;
    if (type === 'dept') {
        var deptId = parseInt(id);
        // Если кликнули тот же dept — сброс
        if (endPoint && endPoint.type === 'dept' && endPoint.deptId === deptId) { clearRoute(); return; }
        ep = findDeptById(deptId);
        if (ep) {
            var bld = findBuildingByDeptId(deptId);
            ep = { id: 'D' + ep.id, type: 'dept', x: ep.x, y: ep.y, name: ep.name, buildingId: bld.id, deptId: ep.id };
        }
    } else if (type === 'building') {
        var bid = parseInt(id);
        if (endPoint && endPoint.type === 'building' && endPoint.buildingId === bid) { clearRoute(); return; }
        var b = findBuildingById(bid);
        if (b) ep = { id: 'B' + b.id, type: 'building', x: b.x, y: b.y, name: b.name, buildingId: b.id };
    }
    if (!ep || !startPoint) return;
    endPoint = ep;

    var result = findPathSnapped(startPoint.x, startPoint.y, ep.x, ep.y);
    if (!result) return;

    lastRouteNodeIds = result.nodes;
    updateDeptItemsActive();
    updateBuildingsListSelection();
    scrollToRoute(result.nodes);
    drawRouteLine(result.nodes, false);
    repositionMarkers();
    updateHint();
    if (startPinEl) startPinEl.classList.add('route-active');
}

// Обратная совместимость: обёртка для вызовов из ui.js
function setRoute(buildingId, deptId, deptName) {
    if (deptId) {
        setEndPoint('dept', deptId);
    } else {
        setEndPoint('building', buildingId);
    }
}

// Сброс ТОЛЬКО цели (startPoint остаётся)
function clearRoute() {
    endPoint = null;
    lastRouteNodeIds = null;
    clearRouteLine();
    updateHint();
    if (startPinEl) startPinEl.classList.remove('route-active');
    updateDeptItemsActive();
    updateBuildingsListSelection();
    if (scrollContainer) {
        centerOnStartPoint();
    }
}

function scrollToRoute(nodeIds) {
    if (!scrollContainer || !mapSizes) return;
    var minX = Infinity, maxX = -Infinity;
    nodeIds.forEach(function(id) {
        var n = allNodes[id];
        var sx = n.x * scale;
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
    });
    var centerX = (minX + maxX) / 2;
    var halfView = scrollContainer.clientWidth / 2;
    scrollContainer.scrollTo({ left: Math.max(0, centerX - halfView), behavior: 'smooth' });
}

function buildSmoothPathData(nodeIds) {
    if (nodeIds.length < 2) return '';
    var CURVE = ROUTE_LINE_CONFIG.curveTension;
    var pts = nodeIds.map(function(id) {
        var n = allNodes[id];
        return { x: n.x * scale, y: n.y * scale };
    });

    var d = 'M ' + pts[0].x + ' ' + pts[0].y;

    if (pts.length === 2) {
        d += ' L ' + pts[1].x + ' ' + pts[1].y;
        return d;
    }

    var f = 0.5 * CURVE;
    var mx = pts[0].x + (pts[1].x - pts[0].x) * f;
    var my = pts[0].y + (pts[1].y - pts[0].y) * f;
    d += ' L ' + mx + ' ' + my;

    for (var i = 1; i < pts.length - 1; i++) {
        var mx2 = pts[i].x + (pts[i + 1].x - pts[i].x) * f;
        var my2 = pts[i].y + (pts[i + 1].y - pts[i].y) * f;
        d += ' Q ' + pts[i].x + ' ' + pts[i].y + ' ' + mx2 + ' ' + my2;
    }

    d += ' L ' + pts[pts.length - 1].x + ' ' + pts[pts.length - 1].y;
    return d;
}

// === ОТРИСОВКА МАРШРУТА ===
var lastRouteNodeIds = null;
var routeSvgEl = null;
var routePathEl = null;
var routeAnimId = null;
var routeGradientEl = null;

function applyRouteGradient(nodeIds) {
    var svgNS = 'http://www.w3.org/2000/svg';
    var grad = routeGradientEl;
    if (!grad && routeSvgEl) {
        var defs = routeSvgEl.querySelector('defs');
        if (!defs) {
            defs = document.createElementNS(svgNS, 'defs');
            routeSvgEl.insertBefore(defs, routeSvgEl.firstChild);
        }
        grad = document.createElementNS(svgNS, 'linearGradient');
        grad.setAttribute('id', 'routeGradient');
        grad.setAttribute('gradientUnits', 'userSpaceOnUse');
        var stops = [
            { offset: '0%', color: '#007aff' },
            { offset: '30%', color: '#8b5cf6' },
            { offset: '60%', color: '#ef4444' },
            { offset: '100%', color: '#ef4444' }
        ];
        stops.forEach(function(st) {
            var s = document.createElementNS(svgNS, 'stop');
            s.setAttribute('offset', st.offset);
            s.setAttribute('stop-color', st.color);
            grad.appendChild(s);
        });
        defs.appendChild(grad);
        routeGradientEl = grad;
    }
    if (!grad || !nodeIds || nodeIds.length < 2) return;
    var s = allNodes[nodeIds[0]];
    var e = allNodes[nodeIds[nodeIds.length - 1]];
    if (!s || !e) return;
    grad.setAttribute('x1', (s.x * scale));
    grad.setAttribute('y1', (s.y * scale));
    grad.setAttribute('x2', (e.x * scale));
    grad.setAttribute('y2', (e.y * scale));
}

function drawRouteLine(nodeIds, skipAnimation) {
    clearRouteLine();

    var markersLayer = document.getElementById('markersLayer');
    markersLayer.classList.remove('markers-hidden');
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('id', 'routeSvg');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '5';

    var d = buildSmoothPathData(nodeIds);

    var path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#E53935');
    path.setAttribute('stroke-width', '4');
    path.setAttribute('stroke-linecap', ROUTE_LINE_CONFIG.lineCap);
    path.setAttribute('stroke-linejoin', ROUTE_LINE_CONFIG.lineJoin);
    path.setAttribute('opacity', '1');

    if (skipAnimation) {
        path.setAttribute('stroke-dasharray', '8 6');
        if (ANIMATE_ROUTE_INFINITE) path.classList.add('route-running');
        svg.appendChild(path);
        markersLayer.appendChild(svg);
        routeSvgEl = svg;
        routePathEl = path;
        applyRouteGradient(nodeIds);
        path.setAttribute('stroke', 'url(#routeGradient)');
    } else {
        var defs = document.createElementNS(svgNS, 'defs');
        var mask = document.createElementNS(svgNS, 'mask');
        mask.setAttribute('id', 'routeMask');
        var maskLine = document.createElementNS(svgNS, 'path');
        maskLine.setAttribute('d', d);
        maskLine.setAttribute('fill', 'none');
        maskLine.setAttribute('stroke', 'white');
        maskLine.setAttribute('stroke-width', '4');
        maskLine.setAttribute('stroke-linecap', ROUTE_LINE_CONFIG.lineCap);
        maskLine.setAttribute('stroke-linejoin', ROUTE_LINE_CONFIG.lineJoin);
        mask.appendChild(maskLine);
        defs.appendChild(mask);
        svg.appendChild(defs);
        path.setAttribute('stroke-dasharray', '8 6');
        path.setAttribute('opacity', '0.9');
        path.setAttribute('mask', 'url(#routeMask)');
        svg.appendChild(path);
        markersLayer.appendChild(svg);
        routeSvgEl = svg;
        routePathEl = path;
        applyRouteGradient(nodeIds);
        path.setAttribute('stroke', 'url(#routeGradient)');

        requestAnimationFrame(function() {
            var totalLen = maskLine.getTotalLength();
            if (totalLen === 0) return;
            maskLine.setAttribute('stroke-dasharray', totalLen);
            maskLine.setAttribute('stroke-dashoffset', totalLen);
            var duration = 1000;
            var startTime = null;
            function animate(ts) {
                if (!startTime) startTime = ts;
                var elapsed = ts - startTime;
                var t = Math.min(elapsed / duration, 1);
                var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
                maskLine.setAttribute('stroke-dashoffset', totalLen * (1 - eased));
                if (t < 1) {
                    routeAnimId = requestAnimationFrame(animate);
                } else {
                    routeAnimId = null;
                    // Пунктир остаётся статичным после прорастания маски, если ANIMATE_ROUTE_INFINITE = false
                    if (ANIMATE_ROUTE_INFINITE) path.classList.add('route-running');
                }
            }
            routeAnimId = requestAnimationFrame(animate);
        });
        return;
    }
}

function clearRouteLine() {
    if (routeAnimId) {
        cancelAnimationFrame(routeAnimId);
        routeAnimId = null;
    }
    if (routeSvgEl && routeSvgEl.parentNode) {
        routeSvgEl.parentNode.removeChild(routeSvgEl);
    }
    routeSvgEl = null;
    routePathEl = null;
    routeGradientEl = null;
}

function updateRoutePathData(nodeIds) {
    if (!routePathEl) return;
    var d = buildSmoothPathData(nodeIds);
    routePathEl.setAttribute('d', d);
    applyRouteGradient(nodeIds);
}

// === ИНТЕРФЕЙС: подсказка, список корпусов, панель (вызываются из main()) ===
// escHtml — утилита экранирования, нужна при ошибке загрузки в main().catch()
function escHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

function updateHint() {
    var panel = document.getElementById('buildingsPanel');
    var isPanelOpen = panel.classList.contains('open');
    var btnChange = document.getElementById('btnChangeStart');
    var btnReset = document.getElementById('btnResetStart');
    var isKPP = startPoint && startPoint.id === 'qr_gate';

    // Кнопки смены/сброса startPoint
    if (btnChange && btnReset) {
        if (!isKPP) {
            btnChange.style.display = 'inline-block';
            btnReset.style.display = 'inline-block';
        } else {
            btnChange.style.display = 'none';
            btnReset.style.display = 'none';
        }
    }

    if (endPoint) {
        hintLabel.textContent = (startPoint ? startPoint.name : '\u0421\u0442\u0430\u0440\u0442') + ' \u2192 ' + endPoint.name;
        hintEmoji.style.display = 'none';
        hintReset.style.display = 'block';
    } else if (isKPP) {
        // КПП по умолчанию, цель не выбрана
        hintLabel.textContent = '\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u0432\u043A\u043B\u0430\u0434\u043A\u0443';
        hintEmoji.style.display = 'inline-block';
        hintReset.style.display = 'none';
    } else if (!isKPP && !endPoint) {
        hintLabel.textContent = '\u0412\u044B \u0437\u0434\u0435\u0441\u044C: ' + startPoint.name + '. \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0446\u0435\u043B\u044C \u043D\u0430 \u043A\u0430\u0440\u0442\u0435';
        hintEmoji.style.display = 'none';
        hintReset.style.display = 'none';
    } else if (!isPanelOpen) {
        hintLabel.textContent = '\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u0432\u043A\u043B\u0430\u0434\u043A\u0443 \u0434\u043B\u044F \u043E\u0437\u043D\u0430\u043A\u043E\u043C\u043B\u0435\u043D\u0438\u044F';
        hintEmoji.style.display = 'inline-block';
        hintReset.style.display = 'none';
    } else {
        hintLabel.textContent = '\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0442\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0434\u043B\u044F \u043F\u043E\u0441\u0442\u0440\u043E\u0435\u043D\u0438\u044F \u043C\u0430\u0440\u0448\u0440\u0443\u0442\u0430';
        hintEmoji.style.display = 'none';
        hintReset.style.display = 'none';
    }
}

function renderBuildingsList() {
    var list = document.getElementById('buildingsList');
    list.innerHTML = '';
    appData.buildings.forEach(function(b) {
        var item = document.createElement('div');
        item.className = 'building-item';
        item.setAttribute('data-building-id', b.id);

        var row = document.createElement('div');
        row.className = 'building-row';
        var deptNamesRaw = getDeptObjects(b.departments).map(function(d) { return d.name || d; });
        row.innerHTML =
            '<div class="building-num">' + b.id + '</div>' +
            '<div class="building-info">' +
                '<div class="building-name">' + escHtml(b.name) + '</div>' +
            '</div>';

        var deptsContainer = document.createElement('div');
        deptsContainer.className = 'depts-container expanded';

    var deptObjs = getDeptObjects(b.departments);
    if (deptObjs.length) {
        deptObjs.forEach(function(dept) {
            var deptItem = document.createElement('div');
            deptItem.className = 'dept-item';
            if (dept.id) deptItem.setAttribute('data-dept-id', dept.id);
            deptItem.innerHTML = '<span class="dept-label">\u2022 ' + escHtml(dept.name || dept) + '</span><span class="dept-reset">\u2715</span>';
            deptItem.querySelector('.dept-reset').addEventListener('click', function(e) {
                e.stopPropagation();
                clearRoute();
            });
            deptItem.addEventListener('click', function(e) {
                if (e.target.classList.contains('dept-reset')) return;
                e.stopPropagation();
                if (dept.id && dept.x !== undefined) {
                    setStartPoint('dept', dept.id);
                }
            });
                deptsContainer.appendChild(deptItem);
            });
    } else {
        deptNamesRaw.forEach(function(deptName) {
            var deptItem = document.createElement('div');
            deptItem.className = 'dept-item';
            deptItem.innerHTML = '<span class="dept-label">\u2022 ' + escHtml(deptName) + '</span><span class="dept-reset">\u2715</span>';
            deptItem.querySelector('.dept-reset').addEventListener('click', function(e) {
                e.stopPropagation();
                clearRoute();
            });
            deptItem.addEventListener('click', function(e) {
                if (e.target.classList.contains('dept-reset')) return;
                e.stopPropagation();
                // Для строковых отделений — открываем корпус как цель
                setEndPoint('building', b.id);
            });
                deptsContainer.appendChild(deptItem);
            });
        }

        item.appendChild(row);
        item.appendChild(deptsContainer);
        list.appendChild(item);
    });
}

function setupPanelToggle() {
    var panel = document.getElementById('buildingsPanel');
    var header = document.getElementById('panelHeader');
    var arrow = document.getElementById('panelArrow');
    
    var ANIMATION_DURATION = 300;
    var animationId = null;
    var isPanelOpen = false;
    
    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    
    function getTargetHeight(open) {
        if (open) {
            var viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
            var headerEl = document.querySelector('.header');
            var hintPanel = document.querySelector('.hint-panel');
            var img = document.getElementById('mapImage');
            var wrapper = document.getElementById('mapWrapper');
            
            var headerHeight = headerEl ? headerEl.offsetHeight : 0;
            var hintHeight = hintPanel ? hintPanel.offsetHeight : 0;
            
            var wrapperWidth = wrapper.clientWidth;
            var mapHeight = (img.naturalHeight * wrapperWidth) / img.naturalWidth;
            
            return viewportHeight - headerHeight - hintHeight - mapHeight;
        }
        return 46;
    }
    
    function animatePanelHeight(fromHeight, toHeight, targetOpen) {
        if (animationId) {
            cancelAnimationFrame(animationId);
        }
        
        var markersLayer = document.getElementById('markersLayer');

        // При закрытии панели — скрываем маркеры на время анимации
        if (!targetOpen && markersLayer) {
            markersLayer.classList.add('markers-hidden');
        }

        var startTime = null;
        
        function step(timestamp) {
            if (!startTime) startTime = timestamp;
            var elapsed = timestamp - startTime;
            var progress = Math.min(elapsed / ANIMATION_DURATION, 1);
            var easedProgress = easeInOutCubic(progress);
            
            var currentHeight = fromHeight + (toHeight - fromHeight) * easedProgress;
            panel.style.height = currentHeight + 'px';
            
            if (scrollContainer) {
                var savedCenter = (scrollContainer.scrollLeft + scrollContainer.clientWidth / 2) / (scale || 1);
            }
            applyScale(false);
            // При открытии — перепозиционируем маркеры, при закрытии — пропускаем (скрыты через markers-hidden)
            if (targetOpen) repositionMarkers();
            if (!targetOpen && scrollContainer) {
                var targetCenter = (startPoint && allNodes[startPoint.id]) ? allNodes[startPoint.id].x : (savedCenter || 0);
                var lerpedCenter = savedCenter + (targetCenter - savedCenter) * easedProgress;
                scrollContainer.scrollLeft = Math.max(0, lerpedCenter * scale - scrollContainer.clientWidth / 2);
            } else if (targetOpen && scrollContainer) {
                scrollContainer.scrollLeft = Math.max(0, savedCenter * scale - scrollContainer.clientWidth / 2);
            }
            if (lastRouteNodeIds) { updateRoutePathData(lastRouteNodeIds); }

            if (progress < 1) {
                animationId = requestAnimationFrame(step);
            } else {
                animationId = null;
                if (targetOpen) {
                    if (scrollContainer) {
                        var savedCenter = (scrollContainer.scrollLeft + scrollContainer.clientWidth / 2) / (scale || 1);
                    }
                    applyScale(true);
                    repositionMarkers();
                    if (lastRouteNodeIds) { drawRouteLine(lastRouteNodeIds, true); }
                    if (scrollContainer) {
                        scrollContainer.scrollLeft = Math.max(0, savedCenter * scale - scrollContainer.clientWidth / 2);
                    }
                } else {
                    applyScale(false);
                    // Показываем маркеры после завершения анимации закрытия
                    if (markersLayer) markersLayer.classList.remove('markers-hidden');
                    repositionMarkers();
                    centerOnStartPoint();
                    if (lastRouteNodeIds) { drawRouteLine(lastRouteNodeIds, true); }
                }
            }
        }
        
        animationId = requestAnimationFrame(step);
    }
    
    header.addEventListener('click', function() {
        isPanelOpen = !isPanelOpen;

        var currentHeight = panel.offsetHeight;
        var targetHeight = getTargetHeight(isPanelOpen);

        if (isPanelOpen) {
            panel.classList.add('open');
            arrow.classList.add('open');
            document.body.classList.add('panel-open');
        } else {
            panel.classList.remove('open');
            arrow.classList.remove('open');
            document.body.classList.remove('panel-open');
        }
        updateHint();

        animatePanelHeight(currentHeight, targetHeight, isPanelOpen);
    });
}

// === ОБРАБОТКА URL-ПАРАМЕТРОВ ===
function handleQRParam() {
    var params = new URLSearchParams(window.location.search);

    // ?start= / ?qr= / ?node= — универсальный параметр установки startPoint
    var scannedId = (params.get('start') || params.get('qr') || params.get('node') || '').trim();
    if (!scannedId) return;

    if (String(scannedId).indexOf('D') === 0) {
        setStartPoint('dept', scannedId.substring(1));
    } else if (String(scannedId).indexOf('B') === 0) {
        setStartPoint('building', scannedId.substring(1));
    } else {
        setStartPoint('start', scannedId);
    }
}

// === ПЕРЕРАСЧЁТ ПРИ ИЗМЕНЕНИИ РАЗМЕРА ОКНА ===
function recalculateLayout() {
    try {
        var img = document.getElementById('mapImage');
        var panel = document.getElementById('buildingsPanel');
        
        if (!img || !img.naturalWidth) return;

        var isPanelOpen = panel.classList.contains('open');
        var savedCenter = scrollContainer ? (scrollContainer.scrollLeft + scrollContainer.clientWidth / 2) / (scale || 1) : null;
        applyScale(isPanelOpen);
        repositionMarkers();
        if (scrollContainer && savedCenter !== null) {
            scrollContainer.scrollLeft = Math.max(0, savedCenter * scale - scrollContainer.clientWidth / 2);
        }
        if (lastRouteNodeIds) {
            updateRoutePathData(lastRouteNodeIds);
        }
    } catch(e) {
        console.warn('recalculateLayout: ошибка пересчёта раскладки', e);
    }
}

function setupResizeHandler() {
    var resizeTimeout;
    function onResize() {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(recalculateLayout, 50);
    }
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onResize);
    }
    window.addEventListener('resize', onResize);
}

// === ЦЕНТРИРОВАНИЕ ПО ТОЧКЕ СТАРТА ===
function centerOnStartPoint() {
    if (!scrollContainer || !mapSizes || !startPoint) return;
    var node = allNodes[startPoint.id];
    if (!node) return;
    var centerX = node.x * scale;
    var halfView = scrollContainer.getBoundingClientRect().width / 2;
    scrollContainer.scrollTo({ left: Math.max(0, centerX - halfView), behavior: 'smooth' });
}

// === ЗАПУСК ===
async function main() {
    hintLabel = document.getElementById('hintLabel');
    hintEmoji = document.getElementById('hintEmoji');
    hintReset = document.getElementById('hintReset');
    hintReset.addEventListener('click', function() { clearRoute(); });

    // Кнопки смены/сброса startPoint
    var btnChange = document.getElementById('btnChangeStart');
    var btnReset = document.getElementById('btnResetStart');
    if (btnChange) btnChange.addEventListener('click', function() {
        var panelHeader = document.getElementById('panelHeader');
        if (panelHeader) {
            // Если панель открыта — закрыть и сразу открыть заново для обновления состояния
            if (document.getElementById('buildingsPanel').classList.contains('open')) {
                panelHeader.click();
            }
            panelHeader.click();
        }
    });
    if (btnReset) btnReset.addEventListener('click', function() {
        localStorage.removeItem('savedStartPoint');
        setStartPoint('start', 'qr_gate');
    });

    await loadData();
    try { computeGeoTransform(); } catch(e) { console.warn('computeGeoTransform: ошибка', e); }
    autoGenerateStartPoints();
    // Инициализация startPoint ДО buildGraph — иначе addEdge(startPoint.id) крашнется
    if (!startPoint) {
        var defaultSp = appData.startPoints[0];
        if (defaultSp) startPoint = { id: defaultSp.id, type: 'start', x: defaultSp.x, y: defaultSp.y, name: defaultSp.name };
    }
    try { handleQRParam(); } catch(e) { console.error('handleQRParam error:', e); }
    buildGraph();
    // Восстановление startPoint из localStorage (только если URL-параметр не переопределил)
    if (startPoint && startPoint.id === 'qr_gate') {
        var saved = localStorage.getItem('savedStartPoint');
        if (saved) {
            try {
                var parsed = JSON.parse(saved);
                setStartPoint(parsed.type, parsed.id);
            } catch(e) { localStorage.removeItem('savedStartPoint'); }
        }
    }
    // При загрузке без URL-параметров — строго старт от КПП
    try {
        var initParams = new URLSearchParams(window.location.search);
        if (!initParams.get('qr') && !initParams.get('start') && !initParams.get('node')) {
            setStartPoint('start', 'qr_gate');
        }
    } catch(e) { console.error('initParams error:', e); }
    await initMap();
    centerOnStartPoint();
    renderMarkers();
    renderLabels();
    updateActiveStartLabel();
    renderBuildingMarkers();
    renderBuildingsList();
    setupPanelToggle();
    setupResizeHandler();
    initWelcomeModal();
    // renderDebugOverlay();

}

// === ОТЛАДОЧНАЯ ВИЗУАЛИЗАЦИЯ ГРАФА ===
function renderDebugOverlay() {
    var old = document.getElementById('debugOverlay');
    if (old) old.remove();
    var ml = document.getElementById('markersLayer');
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('id', 'debugOverlay');
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:150;opacity:0.8;';

    // Рёбра из appData.graph.edges
    if (appData.graph && appData.graph.edges) {
        appData.graph.edges.forEach(function(e) {
            var a = allNodes[e[0]], b = allNodes[e[1]];
            if (!a || !b) return;
            var line = document.createElementNS(ns, 'line');
            line.setAttribute('x1', a.x * scale); line.setAttribute('y1', a.y * scale);
            line.setAttribute('x2', b.x * scale); line.setAttribute('y2', b.y * scale);
            line.setAttribute('stroke', '#90CAF9'); line.setAttribute('stroke-width', '1.5');
            svg.appendChild(line);
        });
    }

    // Waypoints (W)
    if (appData.waypoints) {
        appData.waypoints.forEach(function(w) {
            var cx = w.x * scale, cy = w.y * scale;
            var g = document.createElementNS(ns, 'g');
            var c = document.createElementNS(ns, 'circle');
            c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', '7');
            c.setAttribute('fill', '#42A5F5'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '0.8');
            g.appendChild(c);
            var t = document.createElementNS(ns, 'text');
            t.setAttribute('x', cx + 5); t.setAttribute('y', cy - 4);
            t.setAttribute('fill', '#1565C0'); t.setAttribute('font-size', '9'); t.setAttribute('font-weight', '700');
            t.textContent = w.id; g.appendChild(t);
            svg.appendChild(g);
        });
    }

    ml.appendChild(svg);
}

// === УСТАНОВКА PWA (устаревшее событие beforeinstallprompt) ===
window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredPrompt = e;
});

document.getElementById('installBtn').addEventListener('click', function() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function() { deferredPrompt = null; });
    } else if (window.matchMedia('(display-mode: standalone)').matches) {
        alert('\u2705 Приложение уже установлено. Оно на рабочем столе телефона.');
    } else {
        alert('\uD83D\uDCF2 Как добавить:\n\nAndroid (Chrome): \u22EE \u2192 \u00ABУстановить приложение\u00BB\n\niPhone (Safari): \u2B06\uFE0F \u2192 \u00ABНа экран \u00ABДомой\u00BB');
    }
});

// === ЗАПУСК ПРИЛОЖЕНИЯ ===
main().catch(function(err) {
    if (err.message.indexOf('Не удалось загрузить') !== -1 || !navigator.onLine) {
        var offlineNotice = document.getElementById('offlineNotice');
        if (offlineNotice) offlineNotice.style.display = 'block';
    }
    console.warn('App load failed:', err.message);
});

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(function(reg) {
            console.log('SW registered:', reg.scope);
            reg.addEventListener('updatefound', function() {
                var newWorker = reg.installing;
                if (newWorker) {
                    newWorker.addEventListener('statechange', function() {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            console.log('SW: new version available, reloading...');
                            window.location.reload();
                        }
                    });
                }
            });
            reg.update();
        })
        .catch(function(err) { console.warn('SW registration failed:', err); });
    navigator.serviceWorker.addEventListener('controllerchange', function() {
        window.location.reload();
    });
}

