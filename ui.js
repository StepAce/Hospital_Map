// ui.js — интерфейсные хелперы, вызываемые по клику пользователя (после загрузки обоих скриптов)
'use strict';

var html5QrCode = null;

// === WELCOME MODAL ===

function initWelcomeModal() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('start')) return;

    var modal = document.getElementById('welcomeModal');
    var btnClose = document.getElementById('btnWelcomeClose');
    var btnScan = document.getElementById('btnScanQR');
    var btnManual = document.getElementById('btnManualSelect');
    var btnCancel = document.getElementById('btnCancelScan');
    var actions = document.getElementById('welcomeActions');
    var qrReader = document.getElementById('qr-reader');

    function hideModal() {
        modal.style.display = 'none';
    }

    function showModal() {
        modal.style.display = 'flex';
    }

    function stopScanner() {
        if (html5QrCode) {
            html5QrCode.stop().then(function() {
                html5QrCode = null;
                qrReader.style.display = 'none';
            }).catch(function() {
                html5QrCode = null;
                qrReader.style.display = 'none';
            });
        }
    }

    function onScanSuccess(decodedText) {
        stopScanner();
        hideModal();
        actions.style.display = '';
        btnCancel.style.display = 'none';

        var id = decodedText.trim();
        if (String(id).indexOf('D') === 0) {
            setStartPoint('dept', id.substring(1));
        } else if (String(id).indexOf('B') === 0) {
            setStartPoint('building', id.substring(1));
        } else {
            setStartPoint('start', id);
        }
    }

    function onScanError(err) {
        // Игнорируем — камера продолжает сканировать
    }

    btnClose.addEventListener('click', function() {
        stopScanner();
        hideModal();
    });

    btnManual.addEventListener('click', function() {
        hideModal();
        var panelHeader = document.getElementById('panelHeader');
        if (panelHeader) {
            if (document.getElementById('buildingsPanel').classList.contains('open')) {
                panelHeader.click();
            }
            panelHeader.click();
        }
    });

    btnScan.addEventListener('click', function() {
        actions.style.display = 'none';
        btnCancel.style.display = 'flex';
        qrReader.style.display = 'block';

        html5QrCode = new Html5Qrcode('qr-reader');
        html5QrCode.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            onScanSuccess,
            onScanError
        ).catch(function(err) {
            qrReader.style.display = 'none';
            actions.style.display = '';
            btnCancel.style.display = 'none';
            alert('Не удалось запустить камеру. Проверьте разрешения.');
        });
    });

    btnCancel.addEventListener('click', function() {
        stopScanner();
        actions.style.display = '';
        btnCancel.style.display = 'none';
    });

    showModal();
}

// === END WELCOME MODAL ===

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
}
