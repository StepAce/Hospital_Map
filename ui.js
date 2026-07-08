// ui.js — интерфейсные хелперы, вызываемые по клику пользователя (после загрузки обоих скриптов)
'use strict';

// Обновление выделения корпусов в списке (вызывается из setEndPoint/clearRoute)
function updateBuildingsListSelection() {
    var items = document.querySelectorAll('.building-item');
    items.forEach(function(item) {
        var bid = parseInt(item.getAttribute('data-building-id'));
        if (endPoint && endPoint.type === 'building' && endPoint.buildingId === bid) item.classList.add('selected');
        else item.classList.remove('selected');
        // Подсветка корпуса, выбранного как startPoint
        if (startPoint && startPoint.type === 'building' && startPoint.buildingId === bid) item.classList.add('start-selected');
        else item.classList.remove('start-selected');
    });
}

// Обновление активного пункта отделения (вызывается из setEndPoint/clearRoute)
function updateDeptItemsActive() {
    var deptItems = document.querySelectorAll('.dept-item');
    deptItems.forEach(function(item) {
        var did = item.getAttribute('data-dept-id');
        if (did && endPoint && endPoint.type === 'dept' && endPoint.deptId && parseInt(did) === endPoint.deptId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
        // Подсветка отделения, выбранного как startPoint
        if (did && startPoint && startPoint.type === 'dept' && startPoint.deptId && parseInt(did) === startPoint.deptId) {
            item.classList.add('start-selected');
        } else {
            item.classList.remove('start-selected');
        }
    });
}

// Открытие панели для корпуса при клике на маркер здания (вызывается из renderBuildingMarkers)
function openPanelForBuilding(buildingId) {
    var panel = document.getElementById('buildingsPanel');
    if (!panel.classList.contains('open')) {
        document.getElementById('panelHeader').click();
    }
    collapseAllBuildings();
    expandBuildingAccordion(buildingId);
}
