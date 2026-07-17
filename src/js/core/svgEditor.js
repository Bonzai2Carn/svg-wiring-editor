/* ============================================================
   SVG Wiring Editor — Core Class   (Phase 1 — Edit Mode)
   Constructor, element init, gesture setup, event binding,
   tool registry, keyboard shortcuts, "New Canvas" modal
   ============================================================ */

class MobileSVGEditor {
    constructor() {
        // ── Camera / View State ───────────────────────────────
        this.camera = new CameraMatrix();
        this.currentRotation = 0;
        this.dragStart       = { x: 0, y: 0 };
        
        // GSAP interpolates this object; onUpdate syncs it back to camera
        this._cameraTween    = { zoom: 1, tx: 0, ty: 0, rot: 0 };

        // ── Interaction flags ─────────────────────────────────
        this.isDragging       = false;
        this.isCtrlHeld       = false;
        this.isShiftHeld      = false;
        this._spaceHeld       = false;
        this.isWireTracing    = false;
        this.isConnectionWire = false;
        this.isComponentBox   = false;

        // ── Tool / Mode state (Phase 1) ───────────────────────
        this.activeTool       = 'select';     // 'select'|'pen'|'line'|'rect'|'ellipse'|'polygon'|'text'|'wire'
        this.activeMode       = 'general';    // 'general'|'electrical'|'uml'|'floorplan'
        this._smoothTrace     = false;        // Manhattan (false) vs 45° bends (true)
        this._domainKits      = {};           // pre-init so kits can register before initDomainManager()

        // ── SVG data ──────────────────────────────────────────
        this.wires          = [];
        this.components     = [];
        this.wireConnections= [];
        this.selectedElements = [];
        this.originalViewBox  = null;

        // ── Misc ────────────────────────────────────────────────────
        this.miniMapVisible   = false;
        this.clickTimeout     = null;
        this.toastTimeout     = null;

        // ── rAF batching handle (viewTransform) ──────────────────
        this._transformRafHandle = null;

        // ── Spatial indices (geometryEngine / canvasEngine) ───────
        this._bboxMap   = new Map();    // elementId → {x,y,width,height}
        this.graph      = { nodes: new Map(), edges: new Map(), adjacency: new Map() };
        this._quadTree  = null;         // QuadTree2D, built lazily when nodes > 500

        // ── Measure state ─────────────────────────────────────
        this._measuring         = false;
        this._measurePoints     = [];
        this._measureUnit       = 'px';
        this._measureScaleFactor= null;
        this._measurePxVal      = 1;
        this._measureUnitVal    = 1;

        // ── History ───────────────────────────────────────────
        this._historyStack  = [];
        this._historyIndex  = -1;

        // ── Multi-display ─────────────────────────────────────
        this.displays       = [];
        this.activeDisplayIdx = -1;

        this.SVG_NS = 'http://www.w3.org/2000/svg';

        this.initializeElements();
        this.setupGestures();
        this.bindEvents();
        this.bindEditModeEvents();       // Phase 1
        this.setupTouchFeedback();

        // ── Phase 1 canvas modules ────────────────────────────
        this.initSnapGrid();            // snapGrid.js
        this.initCanvasEngine();        // canvasEngine.js
        this.initDrawingTools();        // drawingTools.js
        this.initClipboard();           // clipboard.js
        this.initAlignDistribute();     // alignDistribute.js
        this.initPropertyPanel();       // propertyPanel.js
        this.initGeometryEngine();      // geometryEngine.js  (spatial indices)

        // ── viewBox-based zoom: recompute base on container resize ──
        if (typeof ResizeObserver !== 'undefined') {
            this._containerRO = new ResizeObserver(() => {
                this.updateTransform();
            });
            this._containerRO.observe(this.$svgContainer[0]);
        }
    }

    initializeElements() {
        this.$svgViewer        = $('#svgViewer');
        this.$svgContainer     = $('#svgContainer');
        this.$svgWrapper       = $('#svgWrapper');
        this.$svgDisplay       = $('#svgDisplay');
        this.$sidePanel        = $('#sidePanel');
        this.$bottomControls   = $('#bottomControls');
        this.$miniMap          = $('#miniMap');
        this.$miniMapSvg       = $('#miniMapSvg');
        this.$miniMapViewport  = $('#miniMapViewport');
        this.$toast            = $('#toast');
        this.$zoomSlider       = $('#zoomSlider');
        this.$rotationSlider   = $('#rotationSlider');
        this.$pitchSlider      = $('#pitchSlider');
        this.$rotateYSlider    = $('#rotateYSlider');
        this.$perspectiveSlider= $('#perspectiveSlider');
    }

    setupGestures() {
        const hammer = new Hammer(this.$svgContainer[0]);
        this._hammer = hammer;  // expose so _editSymbolText can disable touch during text edit

        hammer.get('pan').set({ direction: Hammer.DIRECTION_ALL, threshold: 6 });
        hammer.get('pinch').set({ enable: true });
        hammer.get('rotate').set({ enable: true });
        hammer.get('doubletap').set({ interval: 300, posThreshold: 50 });

        hammer.get('pinch').recognizeWith(hammer.get('rotate'));
        hammer.get('pan').recognizeWith([hammer.get('pinch'), hammer.get('rotate')]);

        let gesture = {
            baseZoom: this.camera.zoom,
            baseRotation: this.currentRotation,
            baseTranslate: { x: this.camera.tx, y: this.camera.ty },
            prevHammerRotation: 0,
            prevHammerScale: 1,
            prevDelta: { x: 0, y: 0 },
            active: false,
        };

        hammer.on('pinchstart rotatestart panstart', (ev) => {
            // Mouse pan/drag is handled by native mousedown/mousemove — let Hammer handle touch only
            if (ev.pointerType === 'mouse') return;
            // Don't pan/pinch while in a drawing tool, text edit, or when viewport is locked
            if (this.activeTool !== 'select') return;
            if (this._textEditActive) return;
            if (this._isViewportLocked && this._isViewportLocked()) return;

            gesture.active = true;
            gesture.baseZoom       = this.camera.zoom;
            gesture.baseRotation   = this.currentRotation;
            gesture.baseTranslate  = { x: this.camera.tx, y: this.camera.ty };
            gesture.prevHammerRotation = ev.rotation || 0;
            gesture.prevHammerScale    = ev.scale    || 1;
            gesture.prevDelta = { x: ev.deltaX || 0, y: ev.deltaY || 0 };
        });

        hammer.on('pinchmove rotatemove panmove', (ev) => {
            if (!gesture.active || this._textEditActive) return;

            if (typeof ev.scale === 'number') {
                const relativeScale = ev.scale / (gesture.prevHammerScale || 1);
                gesture.baseZoom = Math.max(0.1, Math.min(100, gesture.baseZoom * relativeScale));
                this.setZoom(gesture.baseZoom);
                gesture.prevHammerScale = ev.scale;
            }

            if (typeof ev.rotation === 'number') {
                const rotationDelta = ev.rotation - (gesture.prevHammerRotation || 0);
                this.setRotation(this.currentRotation + rotationDelta);
                gesture.prevHammerRotation = ev.rotation;
            }

            if (typeof ev.deltaX === 'number' && typeof ev.deltaY === 'number') {
                const dx = ev.deltaX - (gesture.prevDelta.x || 0);
                const dy = ev.deltaY - (gesture.prevDelta.y || 0);
                this.camera.panBy(dx, dy);
                this.updateTransform();
                gesture.prevDelta.x = ev.deltaX;
                gesture.prevDelta.y = ev.deltaY;
            }

            this.updateSliders();
        });

        hammer.on('pinchend rotateend panend', () => {
            gesture.active = false;
            gesture.prevHammerRotation = 0;
            gesture.prevHammerScale    = 1;
            gesture.prevDelta          = { x: 0, y: 0 };
            gesture.baseZoom           = this.camera.zoom;
            gesture.baseRotation       = this.currentRotation;
            gesture.baseTranslate      = { x: this.camera.tx, y: this.camera.ty };
        });
    }

    setupTouchFeedback() {
        this.touchFeedbackTimeout = null;
    }

    showTouchFeedback(x, y) {
        const $feedback = $('<div class="touch-feedback"></div>');
        $feedback.css({ left: x + 'px', top: y + 'px' });
        this.$svgContainer.append($feedback);
        setTimeout(() => $feedback.remove(), 500);
    }

    bindEvents() {
        // Load file (multi-select)
        // Snapshot panel state on mousedown (before the document click handler closes it)
        // so switchDisplay can restore it after the import finishes.
        $('#loadFileBtn').on('mousedown', () => { this._panelOpenSnap = this.$sidePanel.hasClass('open'); });
        $('#loadFileBtn').on('click', () => $('#hiddenFileInput').click());
        $('#svgFileInput, #hiddenFileInput').on('change', (e) => this.loadSVGFiles(e));

        // New canvas
        $('#newCanvasBtn').on('click', () => this._showNewCanvasModal());

        // Timeline filmstrip
        $('#timelineBtn').on('click', () => this.showTimeline());

        // Trace wire switch
        $('#traceWireBtn').on('click', () => this.toggleWireTracing());

        // Toolbar
        $('#toggleControlsBtn').on('click', () => this.toggleBottomControls());
        $('#resetViewBtn').on('click',  () => this.resetView());

        // Bottom controls
        $('#zoomInBtn').on('click',     () => this.zoomIn());
        $('#zoomOutBtn').on('click',    () => this.zoomOut());
        $('#fitViewBtn').on('click',    () => this.fitToView());
        $('#rotateBtn').on('click',     () => this.rotateView());
        $('#rotateLeftBtn').on('click', () => this.rotateViewLeft());
        $('#layersBtn').on('click', () => {
            if (this.$sidePanel?.hasClass('open')) {
                this.closeSidePanel();
            } else {
                this.showLayers();
            }
        });
        $('#measureBtn').on('click',    () => this.toggleMeasureTool());
        $('#gridToggleBtn').on('click', () => this.toggleGrid());
        $('#snapToggleBtn').on('click', () => this.toggleSnap());

        // Wiring toolbar
        $('#highlightComponentsBtn').on('click', () => {
            if (this.isComponentBox) {
                this.hideComponentBox();
                this.hideModules();
            } else {
                this.highlightComponents(); //highlight shapes  
                this.highlightModules(); // handles shapes + domain symbols (modules)
            }
            this.isComponentBox = !this.isComponentBox;
        });

        $('#showConnectionsBtn').on('click', () => {
            if (this.isConnectionWire) {
                this.hideConnections();
                this.hideConnectors();
            } else {
                this.showConnections();
                this.highlightConnectors();
            }
            this.isConnectionWire = !this.isConnectionWire;
        });

        $('#clearHighlightsBtn').on('click', () => this.clearAllHighlights());

        // Export
        $('#exportViewBtn').on('click',   () => this.exportCurrentView());
        $('#exportHtmlBtn').on('click',   () => this.exportAsHtml());
        $('#exportJsonBtn').on('click',   () => this.exportAsJson());
        $('#batchExportBtn').on('click',  () => this.batchExport());
        $('#toggleMiniMapBtn').on('click',() => this.toggleMiniMap());
        $('#darkModeBtn').on('click',     () => this.toggleDarkMode());

        // Side panel
        $('#closePanelBtn').on('click', () => this.closeSidePanel());

        // Side panel tabs
        $('#sidePanelTabLayers').on('click',     () => this._switchSidePanelTab('layers'));
        $('#sidePanelTabProperties').on('click', () => this._switchSidePanelTab('properties'));

        // Undo / redo
        $('#undoBtn').on('click', () => this.undo());
        $('#redoBtn').on('click', () => this.redo());

        // Sliders
        $('#zoomSlider').on('input',         (e) => this.setZoom(parseFloat(e.target.value)));
        $('#rotationSlider').on('input',     (e) => this.setRotation(parseFloat(e.target.value)));
        $('#pitchSlider').on('input',        (e) => this.setPitch(parseFloat(e.target.value)));
        $('#rotateYSlider').on('input',      (e) => this.setYRotation(parseFloat(e.target.value)));
        $('#perspectiveSlider').on('input',  (e) => {
            const val = parseFloat(e.target.value);
            $('#perspectiveValue').text(val);
            this.$svgWrapper.css('perspective', val + 'px');
        });

        // Mouse drag (only in select mode — drawing tools handle their own)
        this.$svgContainer.on('mousedown', (e) => {
            if (this.activeTool === 'select' || this.activeTool === 'hand') this.startDrag(e);
        });
        $(document).on('mousemove', (e) => { if (this.activeTool === 'select' || this.activeTool === 'hand') this.drag(e); });
        $(document).on('mouseup',  ()  => this.endDrag());

        // Wheel zoom
        this.$svgContainer.on('wheel', (e) => this.handleWheel(e));

        // Keyboard: modifiers + global shortcuts
        $(document).on('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if (e.key === 'Shift')   this.isShiftHeld = true;
            if (e.key === 'Control' || e.key === 'Meta') this.isCtrlHeld = true;
            if (e.key === ' ') { e.preventDefault(); this._spaceHeld = true; }

            const ctrl = e.ctrlKey || e.metaKey;
            const key  = e.key.toLowerCase();

            // Undo / redo (Case-insensitive)
            if (ctrl && !e.shiftKey && key === 'z') { e.preventDefault(); this.undo(); }
            if (ctrl && (key === 'y' || (e.shiftKey && key === 'z'))) { e.preventDefault(); this.redo(); }

            // Delete selected
            if ((e.key === 'Delete' || e.key === 'Backspace') && (this._selection?.length || this.selectedElements?.length)) {
                e.preventDefault(); this.deleteSelected();
            }

            // Ctrl+A = select all
            if (ctrl && key === 'a') { e.preventDefault(); this.selectAll(); }

            // Ctrl+G / Ctrl+Shift+G = group/ungroup
            if (ctrl && !e.shiftKey && key === 'g') { e.preventDefault(); this.groupSelected(); }
            if (ctrl && e.shiftKey  && key === 'g') { e.preventDefault(); this.ungroupSelected(); }

            // Escape = select tool
            if (e.key === 'Escape' && this.activeTool !== 'select') {
                this.setActiveTool('select');
            }

            // Tool hotkeys — single key, no modifier (match button title= hints)
            if (!ctrl && !e.altKey && !e.shiftKey) {
                switch (key) {
                    case 'v': e.preventDefault(); this.setActiveTool('select');  break;
                    case 'h': e.preventDefault(); this.setActiveTool('hand');    break;
                    case 'w': e.preventDefault(); this.setActiveTool('wire');    break;
                    case 'l': e.preventDefault(); this.setActiveTool('line');    break;
                    case 'r': e.preventDefault(); this.setActiveTool('rect');    break;
                    case 'e': e.preventDefault(); this.setActiveTool('ellipse'); break;
                    case 'p': e.preventDefault(); this.setActiveTool('pen');     break;
                    case 't': e.preventDefault(); this.setActiveTool('text');    break;
                }
            }
        });

        $(document).on('keyup', (e) => {
            if (e.key === 'Shift')   this.isShiftHeld = false;
            if (e.key === 'Control' || e.key === 'Meta') this.isCtrlHeld = false;
            if (e.key === ' ') this._spaceHeld = false;
        });

        // Accordion toggle — auto-close siblings
        $(document).on('click', '.accordion.slide-bar', function () {
            const $clicked = $(this);
            const isActive = $clicked.hasClass('active');
            // Close all accordions
            $('.accordion.slide-bar').removeClass('active');
            // If it wasn't active, open it; if it was, leave it closed (toggle)
            if (!isActive) $clicked.addClass('active');
        });

        // Click outside side panel closes it
        $(document).on('click', (e) => {
            const $t = $(e.target);
            if (!$t.closest('#sidePanel').length &&
                !$t.closest('#closePanelBtn, #layersBtn').length &&
                this.$sidePanel.hasClass('open')) {
                this.closeSidePanel();
            }
        });

        // Right-click on canvas: open side panel at Properties tab for the clicked element
        this.$svgContainer.on('contextmenu', (e) => {
            e.preventDefault();
            const target = document.elementFromPoint(e.clientX, e.clientY);
            if (target && target !== this.$svgDisplay[0] && target !== this.$svgContainer[0]) {
                let el = target;
                const symGroup = el.closest?.('.domain-symbol');
                if (symGroup) el = symGroup;
                this.selectEl(el, false);
            }
            if (!this.$sidePanel.hasClass('open')) this.$sidePanel.addClass('open');
            this._switchSidePanelTab('properties');
        });

        // Measure modal
        $(document).on('click', '.measure-tab', (e) => {
            const system = $(e.currentTarget).data('system');
            $('.measure-tab').removeClass('active');
            $(e.currentTarget).addClass('active');
            $('.measure-unit-group').hide();
            $(`.measure-unit-group[data-system="${system}"]`).show();
            const $first = $(`.measure-unit-group[data-system="${system}"] .measure-unit-btn`).first();
            $('.measure-unit-btn').removeClass('active');
            $first.addClass('active');
            const showScale = system !== 'px';
            $('#measureScaleRow').toggle(showScale);
            if (showScale) $('#measureScaleUnitLabel').text($first.data('unit'));
        });

        $(document).on('click', '.measure-unit-btn', (e) => {
            $('.measure-unit-btn').removeClass('active');
            $(e.currentTarget).addClass('active');
            const unit = $(e.currentTarget).data('unit');
            if (unit !== 'px') $('#measureScaleUnitLabel').text(unit);
        });

        $('#measureModalOk').on('click', () => {
            const unit    = $('.measure-unit-btn.active').data('unit') || 'px';
            const pxVal   = parseFloat($('#measurePxVal').val())   || 1;
            const unitVal = parseFloat($('#measureUnitVal').val())  || 1;
            this._measureUnit        = unit;
            this._measurePxVal       = pxVal;
            this._measureUnitVal     = unitVal;
            this._measureScaleFactor = unit === 'px' ? null : (unitVal / pxVal);
            $('#measureModal').removeClass('open');
            this._startMeasuring();
        });

        $('#measureModalCancel').on('click', () => $('#measureModal').removeClass('open'));

        $('#measureModal').on('click', (e) => {
            if ($(e.target).is('#measureModal')) $('#measureModal').removeClass('open');
        });

        // New canvas modal
        $('#newCanvasModalOk').on('click', () => this._createNewCanvas());
        $('#newCanvasModalCancel').on('click', () => $('#newCanvasModal').removeClass('open'));
        $('#newCanvasModal').on('click', (e) => {
            if ($(e.target).is('#newCanvasModal')) $('#newCanvasModal').removeClass('open');
        });

        $(window).on('orientationchange resize', () => {
            setTimeout(() => this.handleOrientationChange(), 100);
        });
    }

    // ── Edit-mode events (Phase 1) ────────────────────────────
    bindEditModeEvents() {
        // Tool buttons in Edit toolbar
        $(document).on('click', '.draw-tool-btn', (e) => {
            const tool = $(e.currentTarget).data('tool');
            if (tool) this.setActiveTool(tool);
        });

        // Smooth Trace toggle
        $('#smoothTraceBtn').on('click', () => {
            this._smoothTrace = !this._smoothTrace;
            $('#smoothTraceBtn').toggleClass('active', this._smoothTrace);
            this.showToast(this._smoothTrace ? 'Smooth Trace ON' : 'Manhattan Routing', 'success');
        });

        // Draw style presets in Edit toolbar
        $('#drawStyleStroke').on('input', (e) => {
            this._drawStyle.stroke = e.target.value;
            if (this._selection?.length) {
                this._selection.forEach(el => el.setAttribute('stroke', e.target.value));
            }
        });
        $('#drawStyleStrokeW').on('input', (e) => {
            this._drawStyle.strokeWidth = e.target.value;
            if (this._selection?.length) {
                this._selection.forEach(el => el.setAttribute('stroke-width', e.target.value));
            }
        });
    }

    // ── New Canvas ────────────────────────────────────────────
    _showNewCanvasModal() {
        $('#newCanvasModal').addClass('open');
    }

    _createNewCanvas() {
        const w = parseInt($('#newCanvasW').val(), 10) || 1200;
        const h = parseInt($('#newCanvasH').val(), 10) || 800;
        const name = $('#newCanvasName').val().trim() || 'New Canvas';

        const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
  <!-- Canvas page background: white so it stands out from the dark editor -->
  <rect id="_canvasBg" width="${w}" height="${h}" fill="white"
    stroke="rgba(0,0,0,0.15)" stroke-width="1"
    data-se-system="true"
    filter="url(#_pageShadow)"/>
  <defs data-se-system="true">
    <filter id="_pageShadow" x="-2%" y="-2%" width="104%" height="104%">
      <feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="rgba(0,0,0,0.3)"/>
    </filter>
  </defs>
</svg>`;

        const firstNewIdx = this.displays.length;
        this.displays.push({
            id: `disp_${Date.now()}`,
            name,
            svgContent,
        });
        this.switchDisplay(firstNewIdx);
        $('#newCanvasModal').removeClass('open');
        this.showToast(`New canvas: ${w}×${h}`, 'success');

        // Start with grid visible on a blank canvas
        if (!this._grid.visible) this.toggleGrid();
    }

    // ── Utility ───────────────────────────────────────────────
    scaleValue(value, fromMin, fromMax, toMin, toMax) {
        return ((value - fromMin) / (fromMax - fromMin)) * (toMax - toMin) + toMin;
    }

    // ── Content root: all user-drawn SVG elements land here ──
    //    Returns _cameraRotGroup if present, otherwise the SVG root.
    //    Used by drawingTools, domainManager, wiringDiagram etc.
    get _contentRoot() {
        return this.$svgDisplay[0].querySelector('#_cameraRotGroup') || this.$svgDisplay[0];
    }
}
