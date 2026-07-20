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
// Аффинное преобразование GPS → пиксели: [a, b, c, d, e, f], где px = a*lat + b*lng + c, py = d*lat + e*lng + f
var geoTransform = null;
// ID watchPosition для постоянного GPS-трекинга
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
    var resp = await fetch('data.json');
    if (!resp.ok) throw new Error('Не удалось загрузить data.json');
    appData = await resp.json();
    metersPerPixel = appData.config.metersPerPixel;
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

                addEdge(startPoint.id, wpts[0].id);

                for (var i = 0; i < wpts.length - 1; i++) {
                    addEdge(wpts[i].id, wpts[i + 1].id);
                }

                addEdge(wpts[wpts.length - 1].id, deptKey);
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
            addEdge(e[0], e[1]);
        });
    }
}

// === АЛГОРИТМ ДЕЙКСТРЫ ===
function findPath(fromKey, toKey) {
    if (!allNodes[fromKey] || !allNodes[toKey]) return null;
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
    if (dist[toKey] === Infinity) return null;
    var path = [toKey];
    var cur = toKey;
    while (cur !== fromKey) { cur = prev[cur]; path.unshift(cur); }
    return { nodes: path, distance: dist[toKey] };
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
        img.src = cfg.mapImage;
    });
}

// === ЛОГИКА МАСШТАБИРОВАНИЯ ===
function applyScale(forceWidthMode) {
    var wrapper = document.getElementById('mapWrapper');
    var img = document.getElementById('mapImage');
    
    var wrapperWidth = wrapper.clientWidth;
    var naturalWidth = img.naturalWidth;
    var naturalHeight = img.naturalHeight;
    
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

function findBuildingById(id) {
    return appData.buildings.find(function(b) { return b.id === id; });
}

// === ОТРИСОВКА МАРКЕРОВ ===
function renderMarkers() {
    var markersLayer = document.getElementById('markersLayer');

    // Булавка в координатах startPoint (не жёстко КПП)
    var container = document.createElement('div');
    container.className = 'pin-container';
    container.style.left = (startPoint.x * scale + PIN_OFFSET_X) + 'px';
    container.style.top = (startPoint.y * scale - PIN_OFFSET_Y) + 'px';

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
                    target: String(d.id)
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

        // Текстовая плашка смещена на (label_x - dot_x, label_y - dot_y)
        var offsetX = (lbl.label_x - lbl.dot_x) * scale;
        var offsetY = (lbl.label_y - lbl.dot_y) * scale;
        var badge = document.createElement('span');
        badge.className = 'label-badge';
        badge.textContent = lbl.text.replace(/\n/g, ' ');
        badge.style.position = 'absolute';
        badge.style.left = offsetX + 'px';
        badge.style.top = offsetY + 'px';
        badge.style.transform = 'translate(-50%, -50%)';
        container.appendChild(badge);

        if (lbl.target) {
            container.addEventListener('click', function() {
                handleLabelTarget(lbl.target);
            });
        }

        layer.appendChild(container);
        labelEls.push({ el: container, data: lbl });
    });
}

function handleLabelTarget(target) {
    var deptId = parseInt(target);
    if (!isNaN(deptId)) {
        var bld = findBuildingByDeptId(deptId);
        if (bld) {
            var deptName = '';
            var depts = getDeptObjects(bld.departments);
            var found = depts.find(function(d) { return d.id === deptId; });
            if (found) deptName = found.name;
            setRoute(bld.id, deptId, deptName);
        }
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
        dot.addEventListener('click', function() { openPanelForBuilding(b.id); });
        layer.appendChild(dot);
        buildingMarkerEls[b.id] = dot;
    });
}

// === УСТАНОВКА ТОЧЕК МАРШРУТА ===

// Установка стартовой точки (откуда идём)
function setStartPoint(type, id) {
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
    if (!sp) return;
    startPoint = sp;
    // Сохраняем в localStorage для восстановления при следующем запуске
    try {
        localStorage.setItem('savedStartPoint', JSON.stringify({
            type: startPoint.type,
            id: startPoint.type === 'dept' ? startPoint.deptId : startPoint.id
        }));
    } catch(e) { /* localStorage недоступен */ }
    repositionMarkers();
    centerOnStartPoint();
    updateDeptItemsActive();
    updateBuildingsListSelection();
    updateHint();
    // Перестроить маршрут если цель уже выбрана и граф построен
    if (endPoint && Object.keys(graph).length > 0) {
        var result = findPath(startPoint.id, endPoint.id);
        if (result) {
            lastRouteNodeIds = result.nodes;
            drawRouteLine(result.nodes, false);
            if (startPinEl) startPinEl.classList.add('route-active');
        }
    }
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
    if (!ep) return;
    endPoint = ep;

    var result = findPath(startPoint.id, endPoint.id);
    if (!result) return;

    lastRouteNodeIds = result.nodes;
    updateDeptItemsActive();
    updateBuildingsListSelection();
    scrollToRoute(result.nodes);
    drawRouteLine(result.nodes, false);
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
    var CURVE = 0.25;
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

function drawRouteLine(nodeIds, skipAnimation) {
    clearRouteLine();

    var markersLayer = document.getElementById('markersLayer');
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('id', 'routeSvg');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '10';

    var d = buildSmoothPathData(nodeIds);

    var path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#E53935');
    path.setAttribute('stroke-width', '3.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');

    if (skipAnimation) {
        path.setAttribute('stroke-dasharray', '8 6');
        path.setAttribute('opacity', '0.9');
        // Бегущий пунктир только если ANIMATE_ROUTE_INFINITE = true
        if (ANIMATE_ROUTE_INFINITE) path.classList.add('route-running');
        svg.appendChild(path);
        markersLayer.appendChild(svg);
        routeSvgEl = svg;
        routePathEl = path;
    } else {
        var defs = document.createElementNS(svgNS, 'defs');
        var mask = document.createElementNS(svgNS, 'mask');
        mask.setAttribute('id', 'routeMask');
        var maskLine = document.createElementNS(svgNS, 'path');
        maskLine.setAttribute('d', d);
        maskLine.setAttribute('fill', 'none');
        maskLine.setAttribute('stroke', 'white');
        maskLine.setAttribute('stroke-width', '3.5');
        maskLine.setAttribute('stroke-linecap', 'round');
        maskLine.setAttribute('stroke-linejoin', 'round');
        mask.appendChild(maskLine);
        defs.appendChild(mask);
        svg.appendChild(defs);
        path.setAttribute('stroke-dasharray', '8 6');
        path.setAttribute('opacity', '0.9');
        path.setAttribute('mask', 'url(#routeMask)');
        svg.appendChild(path);
        markersLayer.appendChild(svg);
        routeSvgEl = svg;

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
}

function updateRoutePathData(nodeIds) {
    if (!routePathEl) return;
    var d = buildSmoothPathData(nodeIds);
    routePathEl.setAttribute('d', d);
}

// === ИНТЕРФЕЙС: подсказка, список корпусов, панель (вызываются из main()) ===
// escHtml — утилита экранирования, нужна при ошибке загрузки в main().catch()
function escHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// === АФФИННОЕ ПРЕОБРАЗОВАНИЕ GPS → ПИКСЕЛИ ===

function matMul(A, B) {
    var m = A.length, n = B[0].length, p = A[0].length;
    var C = [];
    for (var i = 0; i < m; i++) {
        C[i] = [];
        for (var j = 0; j < n; j++) {
            C[i][j] = 0;
            for (var k = 0; k < p; k++) {
                C[i][j] += A[i][k] * B[k][j];
            }
        }
    }
    return C;
}

function matTranspose(A) {
    return A[0].map(function(_, c) { return A.map(function(r) { return r[c]; }); });
}

function matInvert3x3(M) {
    var a = M[0][0], b = M[0][1], c = M[0][2];
    var d = M[1][0], e = M[1][1], f = M[1][2];
    var g = M[2][0], h = M[2][1], i = M[2][2];
    var det = a*(e*i - f*h) - b*(d*i - f*g) + c*(d*h - e*g);
    if (Math.abs(det) < 1e-15) return null;
    var inv = [[0,0,0],[0,0,0],[0,0,0]];
    inv[0][0] = (e*i - f*h) / det;
    inv[0][1] = (c*h - b*i) / det;
    inv[0][2] = (b*f - c*e) / det;
    inv[1][0] = (f*g - d*i) / det;
    inv[1][1] = (a*i - c*g) / det;
    inv[1][2] = (c*d - a*f) / det;
    inv[2][0] = (d*h - e*g) / det;
    inv[2][1] = (b*g - a*h) / det;
    inv[2][2] = (a*e - b*d) / det;
    return inv;
}

function computeGeoTransform() {
    var refs = appData.geoRef;
    if (!refs || refs.length === 0) return;
    var ref = refs[0];
    geoTransform = {
        refLat: ref.lat,
        refLng: ref.lng,
        refX: ref.x,
        refY: ref.y
    };
}

function gpsToPixel(lat, lng) {
    if (!geoTransform) return null;
    var cosLat = Math.cos(geoTransform.refLat * Math.PI / 180);
    var dLat = lat - geoTransform.refLat;
    var dLng = lng - geoTransform.refLng;
    var deltaYMeters = dLat * 111132;
    var deltaXMeters = dLng * 111132 * cosLat;
    var deltaXPx = deltaXMeters / metersPerPixel;
    var deltaYPx = deltaYMeters / metersPerPixel;
    return {
        x: geoTransform.refX + deltaXPx,
        y: geoTransform.refY - deltaYPx
    };
}

// === GPS-ОПРЕДЕЛЕНИЕ МЕСТОПОЛОЖЕНИЯ ===

function requestGPS() {
    if (!navigator.geolocation) {
        alert('\u0412\u0430\u0448 \u0431\u0440\u0430\u0443\u0437\u0435\u0440 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 GPS.');
        return;
    }

    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
        var gpsHint = document.getElementById('gpsHint');
        if (gpsHint) gpsHint.textContent = '\uD83D\uDCCD \u041E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u043C\u043E\u0451 \u043C\u0435\u0441\u0442\u043E\u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043F\u043E GPS';
        return;
    }

    var gpsHint = document.getElementById('gpsHint');
    if (gpsHint) gpsHint.textContent = '\u23F3 \u041E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u043C \u043C\u0435\u0441\u0442\u043E\u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u0435...';

    gpsWatchId = navigator.geolocation.watchPosition(
        function(pos) {
            if (gpsHint) gpsHint.textContent = '\uD83D\uDCCD \u041E\u0442\u0441\u043B\u0435\u0436\u0438\u0432\u0430\u043D\u0438\u0435 GPS \u0430\u043A\u0442\u0438\u0432\u043D\u043E (\u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u0434\u043B\u044F \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438)';
            var pixel = gpsToPixel(pos.coords.latitude, pos.coords.longitude);
            if (!pixel || !startPoint) return;
            var dx = pixel.x - startPoint.x;
            var dy = pixel.y - startPoint.y;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 5) {
                findNearestLocation(pos.coords.latitude, pos.coords.longitude);
            }
        },
        function(err) {
            if (gpsHint) gpsHint.textContent = '\uD83D\uDCCD \u041E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u043C\u043E\u0451 \u043C\u0435\u0441\u0442\u043E\u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043F\u043E GPS';
            var msg;
            switch (err.code) {
                case err.PERMISSION_DENIED: msg = '\u0414\u043E\u0441\u0442\u0443\u043F \u043A GPS \u0437\u0430\u043F\u0440\u0435\u0449\u0451\u043D. \u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u0435 \u0434\u043E\u0441\u0442\u0443\u043F \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430.'; break;
                case err.POSITION_UNAVAILABLE: msg = '\u0421\u0438\u0433\u043D\u0430\u043B GPS \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435, \u0447\u0442\u043E \u0433\u0435\u043E\u043B\u043E\u043A\u0430\u0446\u0438\u044F \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u0430.'; break;
                case err.TIMEOUT: msg = '\u041F\u0440\u0435\u0432\u044B\u0448\u0435\u043D\u043E \u0432\u0440\u0435\u043C\u044F \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u044F GPS. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043D\u0430 \u043E\u0442\u043A\u0440\u044B\u0442\u043E\u0439 \u043C\u0435\u0441\u0442\u043D\u043E\u0441\u0442\u0438.'; break;
                default: msg = '\u041E\u0448\u0438\u0431\u043A\u0430 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0438\u044F \u043C\u0435\u0441\u0442\u043E\u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u044F (\u043A\u043E\u0434 ' + err.code + ').';
            }
            alert(msg);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

function findNearestLocation(lat, lng) {
    var best = null;
    var bestDist = Infinity;

    // Переводим GPS в пиксельные координаты через опорную точку и metersPerPixel
    var px, py;
    var pixel = gpsToPixel(lat, lng);
    if (pixel) {
        px = pixel.x;
        py = pixel.y;
    } else {
        px = lng * 1000;
        py = lat * 1000;
    }

    // Проверяем все startPoints
    if (appData.startPoints) {
        appData.startPoints.forEach(function(sp) {
            var dx = sp.x - px;
            var dy = sp.y - py;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < bestDist) {
                bestDist = dist;
                best = { type: 'start', id: sp.id, name: sp.name };
            }
        });
    }

    // Проверяем все департаменты
    if (appData.buildings) {
        appData.buildings.forEach(function(b) {
            var depts = getDeptObjects(b.departments);
            depts.forEach(function(d) {
                if (d.x === undefined || d.y === undefined) return;
                var dx = d.x - px;
                var dy = d.y - py;
                var dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = { type: 'dept', id: d.id, name: d.name };
                }
            });
        });
    }

    if (best) {
        setStartPoint(best.type, best.id);
        // Свернуть панель если открыта
        var panel = document.getElementById('buildingsPanel');
        if (panel && panel.classList.contains('open')) {
            document.getElementById('panelHeader').click();
        }
        alert('\u041E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u043E: ' + best.name + '. \u0412\u044B \u0437\u0434\u0435\u0441\u044C?');
    } else {
        alert('\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u0431\u043B\u0438\u0436\u0430\u0439\u0448\u0435\u0435 \u043C\u0435\u0441\u0442\u043E.');
    }
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

    // Кнопка GPS: только когда КПП по умолчанию
    var btnGPS = document.getElementById('btnGPS');
    if (btnGPS) {
        btnGPS.style.display = isKPP ? 'inline-block' : 'none';
    }

    if (endPoint) {
        hintLabel.textContent = (startPoint ? startPoint.name : '\u0421\u0442\u0430\u0440\u0442') + ' \u2192 ' + endPoint.name;
        hintEmoji.style.display = 'none';
        hintReset.style.display = 'block';
    } else if (isKPP) {
        // КПП по умолчанию, цель не выбрана
        hintLabel.textContent = '\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u0432\u043E\u0451 \u043C\u0435\u0441\u0442\u043E\u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u0432\u043E \u0432\u043A\u043B\u0430\u0434\u043A\u0435';
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
        var anyExpanded = document.querySelector('.depts-container.expanded');
        if (anyExpanded) {
            hintLabel.textContent = '\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0442\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0434\u043B\u044F \u043F\u043E\u0441\u0442\u0440\u043E\u0435\u043D\u0438\u044F \u043C\u0430\u0440\u0448\u0440\u0443\u0442\u0430';
            hintEmoji.style.display = 'none';
            hintReset.style.display = 'none';
        } else {
            hintLabel.textContent = '\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043A\u043E\u0440\u043F\u0443\u0441';
            hintEmoji.style.display = 'inline-block';
            hintReset.style.display = 'none';
        }
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
                '<div class="building-depts">' + escHtml(deptNamesRaw.join(', ')) + '</div>' +
            '</div>' +
            '<div class="building-arrow">' +
                '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>' +
            '</div>';

        var deptsContainer = document.createElement('div');
        deptsContainer.className = 'depts-container';

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
                // Клик по отделению → установить startPoint
                if (dept.id && dept.x !== undefined) {
                    // Если уже здесь — предупредить
                    if (startPoint && startPoint.type === 'dept' && startPoint.deptId === dept.id) {
                        alert('\u0412\u044B \u0443\u0436\u0435 \u043D\u0430\u0445\u043E\u0434\u0438\u0442\u0435\u0441\u044C \u0437\u0434\u0435\u0441\u044C. \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0446\u0435\u043B\u044C \u043D\u0430 \u043A\u0430\u0440\u0442\u0435.');
                        return;
                    }
                    setStartPoint('dept', dept.id);
                    // Свернуть панель
                    var panel = document.getElementById('buildingsPanel');
                    if (panel.classList.contains('open')) {
                        document.getElementById('panelHeader').click();
                    }
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

        row.addEventListener('click', function() {
            var arrowEl = row.querySelector('.building-arrow');
            var isOpen = deptsContainer.classList.contains('expanded');
            if (isOpen) {
                arrowEl.classList.remove('expanded');
                deptsContainer.classList.remove('expanded');
            } else {
                arrowEl.classList.add('expanded');
                deptsContainer.classList.add('expanded');
            }
            updateHint();
        });

        item.appendChild(row);
        item.appendChild(deptsContainer);
        list.appendChild(item);
    });
}

function collapseAllBuildings() {
    var expandedContainers = document.querySelectorAll('.depts-container.expanded');
    expandedContainers.forEach(function(c) {
        c.classList.remove('expanded');
        var arrow = c.parentElement.querySelector('.building-arrow');
        if (arrow) arrow.classList.remove('expanded');
    });
    if (expandedContainers.length > 0) updateHint();
}

function expandBuildingAccordion(buildingId) {
    var item = document.querySelector('.building-item[data-building-id="' + buildingId + '"]');
    if (!item) return;
    var deptsContainer = item.querySelector('.depts-container');
    var arrowEl = item.querySelector('.building-arrow');
    if (deptsContainer && !deptsContainer.classList.contains('expanded')) {
        deptsContainer.classList.add('expanded');
        if (arrowEl) arrowEl.classList.add('expanded');
        updateHint();
    }
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
                var targetCenter = allNodes[startPoint.id] ? allNodes[startPoint.id].x : (savedCenter || 0);
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

        if (!isPanelOpen) {
            collapseAllBuildings();
        }
        if (isPanelOpen && endPoint && endPoint.buildingId) {
            expandBuildingAccordion(endPoint.buildingId);
        }

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

    // ?start= — новый параметр: устанавливает startPoint (dept_id, start_id, или building_id)
    var startVal = params.get('start');
    if (startVal) {
        if (String(startVal).indexOf('D') === 0) {
            setStartPoint('dept', startVal.substring(1));
        } else if (String(startVal).indexOf('B') === 0) {
            setStartPoint('building', startVal.substring(1));
        } else {
            setStartPoint('start', startVal);
        }
        return;
    }

    // ?qr= — старый параметр (обратная совместимость)
    var qrVal = params.get('qr');
    if (qrVal) {
        setStartPoint('start', qrVal);
    }
}

// === ПЕРЕРАСЧЁТ ПРИ ИЗМЕНЕНИИ РАЗМЕРА ОКНА ===
function recalculateLayout() {
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
    if (!scrollContainer || !mapSizes) return;
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

    // GPS-кнопка и строка в панели
    var btnGPS = document.getElementById('btnGPS');
    var gpsHint = document.getElementById('gpsHint');
    if (btnGPS) btnGPS.addEventListener('click', requestGPS);
    if (gpsHint) gpsHint.addEventListener('click', requestGPS);

    await loadData();
    // Вычисляем аффинное преобразование GPS→пиксели по опорным точкам из geoRef
    computeGeoTransform();
    // Инициализация startPoint ДО buildGraph — иначе addEdge(startPoint.id) крашнется
    if (!startPoint) {
        var defaultSp = appData.startPoints[0];
        if (defaultSp) startPoint = { id: defaultSp.id, type: 'start', x: defaultSp.x, y: defaultSp.y, name: defaultSp.name };
    }
    handleQRParam();
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
    await initMap();
    centerOnStartPoint();
    renderMarkers();
    renderLabels();
    renderBuildingMarkers();
    renderBuildingsList();
    setupPanelToggle();
    setupResizeHandler();

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
    var offlineNotice = document.getElementById('offlineNotice');
    if (offlineNotice) {
        offlineNotice.style.display = 'block';
    }
    // Не затираем карту — она может быть закеширована
    console.warn('App load failed:', err.message);
});

// Service Worker: регистрируется с scope '/' (sw.js лежит в корне, scope определяется по пути скрипта)
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .then(function(reg) { console.log('SW registered:', reg.scope); })
        .catch(function(err) { console.warn('SW registration failed:', err); });
}
