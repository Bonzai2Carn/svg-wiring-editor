/* ============================================================
   SVG Wiring Editor; Wiring Diagram Feature
   SVG file loading, element analysis, interaction setup
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── VS Code file loading ──────────────────────────────────────
    // Called from the inline init script when __GINEXYS_INITIAL_FILE__ is present,
    // and from the ginexys:document-changed message listener for live sync.
    _loadVscodeFile(content, fileName, ext) {
        if (!content || !content.trim()) return;
        let svgContent, sourceFormat;

        if (ext === '.svg' || ext === '.svgz') {
            svgContent = content;
            sourceFormat = 'svg';
        } else if (ext === '.gschema' || ext === '.json') {
            try {
                const payload = JSON.parse(content);
                if (payload.schema === 'ginexys-diagram-v2' && payload.svg) {
                    svgContent = payload.svg;
                    sourceFormat = 'gschema';
                } else {
                    this.showToast('Unrecognised schema format', 'error');
                    return;
                }
            } catch (e) {
                this.showToast('Could not parse file: ' + e.message, 'error');
                return;
            }
        } else {
            this.showToast('Unsupported file type: ' + ext, 'error');
            return;
        }

        // Replace the current display (index 0) rather than stacking a new tab on
        // every live-sync update — only push a new display on the first load.
        const displayObj = {
            id: `disp_vscode_${Date.now()}`,
            analyzed: false,
            snapshot: null,
            name: fileName,
            svgContent,
            sourceFormat,
        };

        if (this.displays.length === 0 || this._vscodeFileLoaded) {
            // Live-sync update: replace slot 0 in-place
            this.displays[0] = displayObj;
            this.activeDisplayIdx = 0;
        } else {
            this.displays.unshift(displayObj);
            this.activeDisplayIdx = 0;
        }
        this._vscodeFileLoaded = true;

        try {
            this._mountParsedSvg(svgContent, `Loaded: ${fileName}`);
        } catch (e) {
            this.showToast('Render error: ' + e.message, 'error');
        }
    },

    loadSVGFiles(event) {
        const files = Array.from(event.target.files);
        event.target.value = ''; // reset so same file can be re-added
        if (!files.length) return;
        this.showLoading(true);

        Promise.all(files.map(f => this._fileToSvgString(f)))
            .then(resultsArray => {
                const flattened = resultsArray.flat();
                if (!flattened.length) return;
                
                const firstNewIdx = this.displays.length;
                flattened.forEach(r => this.displays.push({ 
                    id: `disp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    analyzed: false,
                    snapshot: null,
                    ...r 
                }));
                this.switchDisplay(firstNewIdx);
            })
            .catch(err => this.showToast('Load error: ' + err.message, 'error'))
            .finally(() => this.showLoading(false));
    },

    // ── Switch active display ─────────────────────────────────
    switchDisplay(idx) {
        if (idx < 0 || idx >= this.displays.length) return;

        // Snapshot current canvas into svgContent before leaving so edits survive the switch
        if (this.activeDisplayIdx >= 0 && this.displays[this.activeDisplayIdx]) {
            this.displays[this.activeDisplayIdx].svgContent = this._serializeCurrentDisplay();
        }

        this.activeDisplayIdx = idx;
        const d = this.displays[idx];
        // Consume the mousedown snapshot (set by load button / timeline card) before the
        // document click handler closes the panel. If neither fired, default to false.
        const restorePanel = this._panelOpenSnap ?? false;
        this._panelOpenSnap = undefined;
        // DOM rebuild via importNode invalidates all cached element refs — force fresh analysis
        d.analyzed = false;
        try {
            this._mountParsedSvg(d.svgContent, `Active: ${d.name}`);
        } catch (e) {
            this.showToast(`Render error: ${e.message}`, 'error');
        }
        if (restorePanel && this._layerPanelMode) {
            this.$sidePanel.addClass('open');
            this.buildLayersTree();
        }
        if ($('#timelinePanel').hasClass('open')) this.buildTimeline();
    },

    // viewBox string describing the page rect (#_canvasBg), or null when the
    // active document has no page — e.g. a plain imported SVG.
    _pageViewBox() {
        const bg = this.$svgDisplay?.[0]?.querySelector('#_canvasBg');
        if (!bg) return null;
        const x = parseFloat(bg.getAttribute('x')) || 0;
        const y = parseFloat(bg.getAttribute('y')) || 0;
        const w = parseFloat(bg.getAttribute('width'));
        const h = parseFloat(bg.getAttribute('height'));
        if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
        return `${x} ${y} ${w} ${h}`;
    },

    // ── Clean SVG serializer: content only, no camera/grid infrastructure ──
    // Lifts user elements out of _cameraRotGroup and uses originalViewBox
    // so the output can round-trip through _mountParsedSvg without data loss.
    _serializeCurrentDisplay() {
        const svg = this.$svgDisplay[0];
        if (!svg) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"></svg>';
        const contentRoot = this._contentRoot;
        const NS = this.SVG_NS;

        // The page rect is the export viewport. #svgDisplay is the infinite
        // surface — its viewBox drifts with fit/zoom and is not what you meant
        // to export. Fall back to originalViewBox for imported SVGs with no page.
        const vb = this._pageViewBox() || this.originalViewBox || '0 0 1200 800';
        const tempSvg = document.createElementNS(NS, 'svg');
        tempSvg.setAttribute('xmlns', NS);
        tempSvg.setAttribute('viewBox', vb);
        tempSvg.setAttribute('width', '100%');
        tempSvg.setAttribute('height', '100%');

        // Copy non-grid root-level defs (patterns, filters, markers, etc.)
        Array.from(svg.children).forEach(child => {
            if (child.tagName === 'defs' && child.id !== '_gridDefs') {
                tempSvg.appendChild(document.importNode(child, true));
            }
        });

        // Copy user content (skip grid layer and transient selection handles)
        if (contentRoot) {
            Array.from(contentRoot.children).forEach(child => {
                if (child.id === '_gridLayer') return;
                if (child.classList.contains('selection-handle-group')) return;
                tempSvg.appendChild(document.importNode(child, true));
            });
        }

        return new XMLSerializer().serializeToString(tempSvg);
    },

    _fileToSvgString(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        const wrap = (promise) => promise.then(svg => [{ name: file.name, svgContent: svg, sourceFormat: ext }]);

        if (ext === 'svg' || ext === 'svgz' || file.type === 'image/svg+xml')
            return wrap(this._readTextFile(file));
        if (ext === 'pdf' || file.type === 'application/pdf')
            return this._pdfFileToSvg(file, ext);
        if (ext === 'plt' || ext === 'hpgl')
            return wrap(this._readTextFile(file).then(text => this._hpglToSvg(text)));
        if (ext === 'dwf' || ext === 'dwfx')
            return wrap(this._dwfFileToSvg(file));
        if (['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff'].includes(ext) || file.type.startsWith('image/'))
            return wrap(this._rasterFileToSvg(file));
        return Promise.reject(new Error(`Unsupported format: .${ext}`));
    },

    _readTextFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = () => reject(new Error('File read error'));
            reader.readAsText(file);
        });
    },

    _pdfFileToSvg(file, sourceExt = 'pdf') {
        if (typeof pdfjsLib === 'undefined') return Promise.reject(new Error('PDF renderer not available'));
        const url = URL.createObjectURL(file);

        return pdfjsLib.getDocument(url).promise
            .then(async pdf => {
                const numPages = pdf.numPages;
                const pages = [];
                for (let i = 1; i <= numPages; i++) {
                    try {
                        const page = await pdf.getPage(i);
                        const viewport = page.getViewport({ scale: 1.0 }); // Native units
                        const opList = await page.getOperatorList();

                        // ── Primary path: CTM-resolved vector extraction ──
                        // Deterministic primitives (lines/curves/rects) with the full
                        // transform chain applied; text glyphs never enter the output.
                        if (window.GxCtmAdapter && pdfjsLib.OPS) {
                            try {
                                const extracted = GxCtmAdapter.extractSubpaths(opList, viewport, pdfjsLib.OPS);
                                const hasContent = extracted.subpaths.some(sp => sp.segs.length || sp.curves.length)
                                    || extracted.filledRects.length;
                                if (hasContent) {
                                    // Labels come from getTextContent, not from the op
                                    // stream: the op stream carries glyph indices into
                                    // a subset font, so reading text there means
                                    // reimplementing CMap decoding. pdf.js already did
                                    // that, and on a schematic the labels ARE the
                                    // meaning — a sheet with no R1, no GND and no pin
                                    // names is a picture of a circuit, not a circuit.
                                    let textSvg = '';
                                    try {
                                        textSvg = this._pdfTextToSvg(
                                            await page.getTextContent(), viewport);
                                    } catch (txtErr) {
                                        console.warn(`[PDF] text layer failed on P${i}:`, txtErr);
                                    }
                                    pages.push({
                                        name: numPages > 1 ? `${file.name} - P${i}` : file.name,
                                        svgContent: GxCtmAdapter.subpathsToSvg(extracted, viewport, textSvg),
                                        sourceFormat: sourceExt,
                                    });
                                    continue;
                                }
                                // No vector content — fall through to SVGGraphics
                                // (page may be raster-only; renderer at least shows it)
                            } catch (adapterErr) {
                                console.warn(`[PDF] ctmAdapter failed on P${i}, falling back:`, adapterErr);
                            }
                        }

                        // ── Fallback: legacy SVGGraphics renderer ──
                        // SANITIZE: Remove shading ops which crash the experimental SVG renderer
                        if (pdfjsLib.OPS && pdfjsLib.OPS.shadingFill !== undefined) {
                            const bypassOps = [ pdfjsLib.OPS.shadingFill ];
                            const filteredFn = [];
                            const filteredArgs = [];
                            for (let j = 0; j < opList.fnArray.length; j++) {
                                if (!bypassOps.includes(opList.fnArray[j])) {
                                    filteredFn.push(opList.fnArray[j]);
                                    filteredArgs.push(opList.argsArray[j]);
                                }
                            }
                            opList.fnArray = filteredFn;
                            opList.argsArray = filteredArgs;
                        }

                        const svgGfx = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
                        
                        // Catch internal SVGGraphics errors (like subarray readings on corrupt inline images)
                        let svgElement;
                        try {
                            svgElement = await svgGfx.getSVG(opList, viewport);
                        } catch (renderErr) {
                            console.warn(`[PDF] SVGGraphics failed gracefully on P${i}:`, renderErr);
                            continue; // Skip appending this page if getSVG hard crashes
                        }
                        
                        // Flatten hierarchy so every path/line is top-level and has its own transform
                        if (svgElement) {
                            this.ungroupAll(svgElement);
                            pages.push({
                                name: numPages > 1 ? `${file.name} - P${i}` : file.name,
                                svgContent: new XMLSerializer().serializeToString(svgElement),
                                sourceFormat: sourceExt
                            });
                        }
                    } catch (pageErr) {
                        console.warn(`[PDF] Could not read page ${i}:`, pageErr);
                    }
                }
                
                if (pages.length === 0) {
                    throw new Error('All pages failed to render (unsupported shading/images).');
                }
                
                return pages;
            })
            .finally(() => URL.revokeObjectURL(url));
    },

    /**
     * pdf.js text items -> <text> elements in viewport space.
     *
     * Each item carries its own text matrix in PDF space; composing that with
     * the viewport transform gives the baseline origin directly, which is what
     * <text> wants. The y axis flips between the two spaces, so the glyphs are
     * un-flipped with a local scale(1,-1) rather than by negating coordinates —
     * negating would put the baseline in the right place and the glyphs upside
     * down, which is the classic version of this bug.
     *
     * Rotated labels (net names along a vertical bus) keep their rotation
     * because the matrix is used whole rather than reduced to a position.
     */
    _pdfTextToSvg(textContent, viewport) {
        const items = (textContent && textContent.items) || [];
        if (!items.length) return '';
        const vt = viewport.transform;
        const mul = (a, b) => [
            a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
        ];
        const esc = (t) => String(t)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const r = (n) => Math.round(n * 100) / 100;

        const parts = [];
        for (const it of items) {
            const str = it && it.str;
            if (!str || !str.trim() || !it.transform) continue;
            const m = mul(vt, it.transform);
            // Font size is the length of the transformed text-space y basis.
            const size = Math.hypot(m[1], m[3]) || 8;
            if (size < 0.4) continue;              // sub-visible, not a label
            // The matrix ALREADY carries the font size — a text matrix maps a
            // 1-unit em box into place. Setting font-size beside it multiplies
            // the two, which is why the first version rendered 6.66pt labels at
            // 44pt. Normalise the basis vectors out and let font-size carry the
            // scale on its own, so the attribute means what it says.
            const n = [m[0] / size, m[1] / size, m[2] / size, m[3] / size];
            parts.push(
                `<text transform="matrix(${r(n[0])} ${r(n[1])} ${r(n[2])} ${r(n[3])} ` +
                `${r(m[4])} ${r(m[5])}) scale(1,-1)" font-size="${r(size)}" ` +
                `font-family="monospace" fill="rgb(60,60,60)" ` +
                // Labels draw, but they are not geometry: 'ink' keeps them out
                // of wire/component classification, where a word would otherwise
                // be scored as a shape and land in the netlist.
                `data-geo-class="ink" data-gx-label="${esc(str.trim())}" ` +
                `style="pointer-events:none">${esc(str)}</text>`
            );
        }
        return parts.length
            ? `<g data-gx-textlayer="true" data-geo-class="ink">${parts.join('')}</g>`
            : '';
    },

    ungroupAll(svgElement) {
        // Find all groups. We use a while loop to handle deep nesting
        let groups = svgElement.querySelectorAll('g');
        while (groups.length > 0) {
            groups.forEach(group => {
                const parent = group.parentNode;
                if (!parent) return;

                // Move all children out of the group
                while (group.firstChild) {
                    const child = group.firstChild;

                    // Skip non-element nodes (like text if any)
                    if (child.nodeType !== 1) {
                        parent.insertBefore(child, group);
                        continue;
                    }

                    // Apply the group's transform to the child
                    const combinedTransform = this.consolidateTransforms(group, child);
                    if (combinedTransform) {
                        child.setAttribute('transform', combinedTransform);
                    }

                    // Move child to parent level
                    parent.insertBefore(child, group);
                }
                // Remove the now-empty group
                parent.removeChild(group);
            });
            // Re-query to see if we uncovered more nested groups
            groups = svgElement.querySelectorAll('g');
        }
    },

    consolidateTransforms(parent, child) {
        const pT = parent.getAttribute('transform') || '';
        const cT = child.getAttribute('transform') || '';
        if (!pT) return cT;
        if (!cT) return pT;

        try {
            // Modern browsers support DOMMatrix for robust math
            const m1 = new DOMMatrix(pT);
            const m2 = new DOMMatrix(cT);
            return m1.multiply(m2).toString();
        } catch (e) {
            // Fallback to simple concatenation if matrix parsing fails
            return `${pT} ${cT}`;
        }
    },


    _dwfFileToSvg(file) {
        return this._readTextFile(file).then(text => {
            const m = text.match(/<svg[\s\S]*?<\/svg>/i);
            if (!m) throw new Error('DWF not renderable in-browser. Export as SVG or PDF first.');
            return m[0];
        });
    },

    _rasterFileToSvg(file) {
        if (typeof ImageTracer === 'undefined') return Promise.reject(new Error('ImageTracer not loaded; check network'));
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const svgStr = ImageTracer.imagedataToSVG(imageData, {
                        ltres: 1, qtres: 1, pathomit: 8, rightangleenhance: true,
                        colorsampling: 2, numberofcolors: 16, mincolorratio: 0, colorquantcycles: 3,
                        scale: 1, strokewidth: 1, linefilter: false, viewbox: true, desc: false,
                        blurradius: 0, blurdelta: 20,
                    });
                    svgStr ? resolve(svgStr) : reject(new Error('ImageTracer returned empty result'));
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Failed to load image')); };
            img.src = objectUrl;
        });
    },

    // ── Shared: mount a parsed SVG string into the display and activate all features ──
    _mountParsedSvg(svgContent, toastMsg) {
        // Kill any in-flight fitToView/zoom animation so the previous display's
        // tween can't override the camera state of the newly mounted display.
        if (typeof gsap !== 'undefined') gsap.killTweensOf(this._cameraTween);

        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
        const svgElement = svgDoc.querySelector('svg');
        if (!svgElement) throw new Error('Invalid SVG content');

        // ── Clear and rebuild DOM ──────────────────────────────
        this.$svgDisplay.empty();

        // Apply viewBox from loaded SVG (defines coordinate space)
        const viewBox = svgElement.getAttribute('viewBox');
        if (viewBox) {
            this.$svgDisplay.attr('viewBox', viewBox);
            this.originalViewBox = viewBox;
        } else {
            // Synthesise a viewBox from width/height attributes if present
            const w = svgElement.getAttribute('width');
            const h = svgElement.getAttribute('height');
            if (w && h) {
                const vb = `0 0 ${parseFloat(w)} ${parseFloat(h)}`;
                this.$svgDisplay.attr('viewBox', vb);
                this.originalViewBox = vb;
            }
        }

        // SVG MUST fill the wrapper — let viewBox + CSS handle the scale.
        // DO NOT hard-code pixel width/height here; that's what caused bug #1.
        this.$svgDisplay.attr('width', '100%').attr('height', '100%');

        // .empty() wiped _cameraRotGroup and the grid — rebuild both before importing content.
        const NS = this.SVG_NS;
        const rotGroup = document.createElementNS(NS, 'g');
        rotGroup.id = '_cameraRotGroup';
        this.$svgDisplay[0].appendChild(rotGroup);
        // Re-insert _gridDefs at SVG root and _gridLayer as first child of rotGroup
        this._renderGridPattern();

        const contentRoot = this._contentRoot;  // resolves to the fresh rotGroup

        $(svgElement).children().each((_, child) => {
            const cid = child.id || '';
            if (cid === '_gridDefs' || cid === '_gridLayer' || cid === '_cameraRotGroup') return;
            if (child.tagName === 'defs') {
                // Merge defs into SVG root so patterns/filters remain accessible
                this.$svgDisplay.append($(child).clone());
                return;
            }
            contentRoot.appendChild(document.importNode(child, true));
        });

        // Apply system shield to any imported canvas background so it can't be accidentally moved/deleted.
        const importedBg = contentRoot.querySelector('#_canvasBg');
        if (importedBg) importedBg.setAttribute('data-se-system', 'true');

        // Everything mounted here gets a page. See _ensurePageRect.
        this._ensurePageRect(contentRoot, svgElement);

        // If a white canvas page background was imported (_canvasBg), move _gridLayer
        // to sit just after it so the grid is visible on the white surface.
        this._repositionGridLayer();

        this.setupSVGInteractions();

        // Reset view state then fit content into viewport
        this.camera.setState({ zoom: 1, tx: 0, ty: 0 });
        this.currentRotation  = 0;
        this.updateTransform();

        // Delay fitToView so the DOM has painted and getBoundingClientRect is accurate
        setTimeout(() => this.fitToView(), 80);

        this.updateMiniMap?.();
        // Point the background picker at the page this document actually has
        this._syncCanvasBgControls?.();
        // Boot mount is not news — nobody needs "Active: Untitled Canvas" on load.
        if (toastMsg && !this._suppressMountToast) this.showToast(toastMsg, 'success');
        // this.closeSidePanel();

        // Re-attach the MutationObserver to the freshly-created _cameraRotGroup.
        // _mountParsedSvg wipes and recreates the DOM, so the old observer target
        // is gone — without this call the layers panel never auto-updates after load.
        this._initLayerObserver?.();
    },

    /**
     * Guarantee the mounted document owns a page rect naming its OWN dimension.
     *
     * #svgDisplay is the infinite surface every artboard floats on. Its viewBox
     * is a camera: fit, zoom and switching artboards all rewrite it. A document
     * that states no page of its own therefore has no dimension of its own — it
     * borrows the viewport's, and the viewport belongs to whatever is on screen
     * rather than to the artwork.
     *
     * That is what put an imported figure at the wrong size. Nothing rescaled
     * it; it never had a size to keep. #_canvasBg is what fitToView frames, what
     * the exporter crops to, what the grid is laid over and what _canvasToScene
     * measures a send-back against — four subsystems that were all reading the
     * camera for figures that arrived without a page.
     *
     * An image is content ON a page, never the page itself.
     */
    _ensurePageRect(contentRoot, srcSvg) {
        if (!contentRoot || contentRoot.querySelector('#_canvasBg')) return;
        const box = this._documentBox(contentRoot, srcSvg);
        if (!box) return;

        const NS = this.SVG_NS;
        // The shadow filter has to exist in THIS document before anything points
        // at it. An unresolvable filter reference does not degrade to "no
        // shadow" — the SVG spec drops the element entirely, so the page would
        // simply not render.
        let shadow = this.$svgDisplay[0].querySelector('#_pageShadow');
        if (!shadow) {
            const defs = document.createElementNS(NS, 'defs');
            defs.setAttribute('data-se-system', 'true');
            defs.innerHTML =
                '<filter id="_pageShadow" x="-2%" y="-2%" width="104%" height="104%">' +
                '<feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="rgba(0,0,0,0.3)"/>' +
                '</filter>';
            this.$svgDisplay[0].appendChild(defs);
            shadow = defs.querySelector('#_pageShadow');
        }

        const rect = document.createElementNS(NS, 'rect');
        rect.id = '_canvasBg';
        rect.setAttribute('x', String(box.x));
        rect.setAttribute('y', String(box.y));
        rect.setAttribute('width', String(box.w));
        rect.setAttribute('height', String(box.h));
        rect.setAttribute('fill', 'white');
        rect.setAttribute('stroke', 'rgba(0,0,0,0.15)');
        rect.setAttribute('stroke-width', '1');
        rect.setAttribute('data-se-system', 'true');
        // Recorded so a send-back can tell a page the document declared from one
        // this editor inferred, and weight the second less.
        rect.setAttribute('data-gx-page-source', box.source);
        if (shadow) rect.setAttribute('filter', 'url(#_pageShadow)');
        contentRoot.insertBefore(rect, contentRoot.firstChild);
    },

    /**
     * The page box for a document that did not state one, most authoritative
     * evidence first: its viewBox, then its width/height, then the bounds of
     * what it actually drew.
     *
     * The last is the weakest and still beats a constant: a figure framed to its
     * own ink is at worst cropped tight, whereas a default page is a claim about
     * size that happens to be false.
     */
    _documentBox(contentRoot, srcSvg) {
        const vb = (srcSvg?.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        if (vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0) {
            return { x: vb[0], y: vb[1], w: vb[2], h: vb[3], source: 'viewbox' };
        }
        const w = parseFloat(srcSvg?.getAttribute('width'));
        const h = parseFloat(srcSvg?.getAttribute('height'));
        if (isFinite(w) && isFinite(h) && w > 0 && h > 0) {
            return { x: 0, y: 0, w, h, source: 'size-attrs' };
        }
        const b = this._contentBox(contentRoot);
        return b ? { ...b, source: 'content-bounds' } : null;
    },

    /** Union of the drawn children's bounds, ignoring editor infrastructure. */
    _contentBox(contentRoot) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        Array.from(contentRoot.children).forEach((el) => {
            // The grid is painted across the whole surface by design; measuring
            // it would report the viewport back as the document's size, which is
            // the exact confusion this pass exists to end.
            if (el.id === '_gridLayer' || el.tagName === 'defs') return;
            if (el.classList?.contains('selection-handle-group')) return;
            let b;
            try { b = el.getBBox(); } catch (_) { return; }
            if (!b || (!b.width && !b.height)) return;
            x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
            x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
        });
        if (!isFinite(x0) || x1 <= x0 || y1 <= y0) return null;
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    },



    /* 
    _pdfOpsToSvg(page) {
        // [DEPRECATED] Replaced by official SVGGraphics backend in _pdfFileToSvg
        ...
    }
    _cmykToHex(c, m, y, k) { ... }
    */



    _hpglToSvg(hpgl) {
        const penColors = ['#000000', '#e53935', '#43a047', '#1e88e5', '#fb8c00', '#8e24aa', '#00acc1', '#6d4c41'];
        const paths = [];
        let currentPath = '';
        let penDown = false;
        let currentX = 0, currentY = 0;
        let currentPen = 0;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        const updateBounds = (x, y) => {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        };
        const flushPath = () => {
            if (currentPath) { paths.push({ d: currentPath, pen: currentPen }); currentPath = ''; }
        };

        const tokens = hpgl.replace(/\r/g, '').split(/[;\n]+/).map(t => t.trim()).filter(Boolean);

        for (const token of tokens) {
            const cmd = token.slice(0, 2).toUpperCase();
            const args = token.slice(2).trim().split(/[\s,]+/).filter(Boolean).map(Number);

            switch (cmd) {
                case 'IN':
                    flushPath(); currentX = 0; currentY = 0; penDown = false; break;
                case 'SP':
                    flushPath(); currentPen = Math.max(0, (args[0] || 1) - 1); break;
                case 'PU':
                    flushPath(); penDown = false;
                    if (args.length >= 2) {
                        for (let i = 0; i + 1 < args.length; i += 2) {
                            currentX = args[i]; currentY = args[i + 1]; updateBounds(currentX, currentY);
                        }
                    }
                    break;
                case 'PD':
                    penDown = true;
                    if (!currentPath) currentPath = `M ${currentX} ${currentY}`;
                    if (args.length >= 2) {
                        for (let i = 0; i + 1 < args.length; i += 2) {
                            currentX = args[i]; currentY = args[i + 1]; updateBounds(currentX, currentY);
                            currentPath += ` L ${currentX} ${currentY}`;
                        }
                    }
                    break;
                case 'PA':
                    if (args.length >= 2) {
                        for (let i = 0; i + 1 < args.length; i += 2) {
                            currentX = args[i]; currentY = args[i + 1]; updateBounds(currentX, currentY);
                            if (penDown) {
                                if (!currentPath) currentPath = `M ${currentX} ${currentY}`;
                                else currentPath += ` L ${currentX} ${currentY}`;
                            } else {
                                flushPath(); currentPath = `M ${currentX} ${currentY}`;
                            }
                        }
                    }
                    break;
                case 'PR':
                    if (args.length >= 2) {
                        for (let i = 0; i + 1 < args.length; i += 2) {
                            currentX += args[i]; currentY += args[i + 1]; updateBounds(currentX, currentY);
                            if (penDown) {
                                if (!currentPath) currentPath = `M ${currentX} ${currentY}`;
                                else currentPath += ` L ${currentX} ${currentY}`;
                            } else {
                                flushPath(); currentPath = `M ${currentX} ${currentY}`;
                            }
                        }
                    }
                    break;
                case 'CI': {
                    const r = args[0] || 1;
                    updateBounds(currentX - r, currentY - r); updateBounds(currentX + r, currentY + r);
                    paths.push({ d: `M ${currentX - r} ${currentY} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`, pen: currentPen });
                    break;
                }
            }
        }
        flushPath();

        if (!paths.length) throw new Error('No drawable content found in PLT file');

        const pad = 20;
        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
        const w = maxX - minX + pad * 2;
        const h = maxY - minY + pad * 2;
        const ox = -minX + pad, oy = -minY + pad;

        const pathEls = paths.map(p => {
            const color = penColors[p.pen % penColors.length];
            return `<path d="${p.d}" stroke="${color}" stroke-width="1" fill="none" transform="translate(${ox} ${oy})"/>`;
        }).join('\n');

        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">\n${pathEls}\n</svg>`;
    },

    setupSVGInteractions() {
        // Run analysis — lazy: skip if this display was already analyzed
        const d = this.displays[this.activeDisplayIdx];
        if (!d?.analyzed) {
            this.analyzeWiringDiagram();
        } else {
            // Restore cached analysis state without re-running
            this.wires          = d._wires      || [];
            this.components     = d._components || [];
            this.graph          = d._graph      || { nodes: new Map(), edges: new Map(), adjacency: new Map() };
            this._bboxMap       = d._bboxMap    || new Map();
        }

        if ('ontouchstart' in window) return;

        // ── O(1) delegated listeners (not per-element) ───────────
        const WIRE_SELECTORS = 'path,line,polyline,polygon,circle,ellipse,rect';
        this.$svgDisplay
            .off('.interact')
            .on('mouseenter.interact', WIRE_SELECTORS, (e) => {
                if (!this.selectedElements.includes(e.target))
                    this.highlightElement($(e.target), true);
            })
            .on('mouseleave.interact', WIRE_SELECTORS, (e) => {
                if (!this.selectedElements.includes(e.target))
                    this.highlightElement($(e.target), false);
            });
    },

    analyzeWiringDiagram() {
        // ── Delegate to 4-phase geometry engine if available ─
        if (typeof this._runGeometryPipeline === 'function') {
            this._runGeometryPipeline();

            // Cache results back into display record for lazy re-mount
            const d = this.displays[this.activeDisplayIdx];
            if (d) {
                d._wires      = this.wires;
                d._components = this.components;
                d._graph      = this.graph;
                d._bboxMap    = this._bboxMap;
            }
            return;
        }

        // ── Legacy fallback (tag-name heuristics) ─────────────
        this._legacyAnalyze();
    },

    _legacyAnalyze() {
        this.wires = []; this.components = []; this.connections = [];
        const SVG_NS = this.SVG_NS;

        this.$svgDisplay.find(
            'line, path[d*="L"], path[d*="l"], path[d*="v"], path[d*="V"], path[d*="h"], path[d*="H"], polyline'
        ).each((index, origEl) => {
            const $orig = $(origEl);
            const originalStroke      = $orig.attr('stroke') || 'black';
            const originalStrokeWidth = parseFloat($orig.attr('stroke-width') || '1');
            const group = document.createElementNS(SVG_NS, 'g');
            group.setAttribute('class', 'wire-group');
            group.setAttribute('data-wire-id', `wire_${index}`);
            const cloneVisual = origEl.cloneNode(true);
            const cloneHitbox = origEl.cloneNode(true);
            cloneHitbox.setAttribute('stroke', originalStroke);
            cloneHitbox.setAttribute('stroke-opacity', '0');
            cloneHitbox.setAttribute('fill', 'none');
            cloneHitbox.setAttribute('class', 'wire-hitbox');
            cloneHitbox.setAttribute('data-wire-id', `wire_${index}`);
            group.appendChild(cloneVisual); group.appendChild(cloneHitbox);
            origEl.parentNode.replaceChild(group, origEl);
            this.wires.push({ element: cloneVisual, $element: $(cloneVisual),
                $hitbox: $(cloneHitbox), $group: $(group),
                id: `wire_${index}`, color: originalStroke, width: originalStrokeWidth });
        });

        this.$svgDisplay.find(
            'circle, rect, polygon, ellipse, path[d*="c"], path[d*="C"], path[d*="s"], path[d*="S"], g'
        ).not('.wire-group, .wire-group *, .component-group, .component-group *').each((index, origEl) => {
            const $orig = $(origEl);
            const bbox = origEl.getBBox ? origEl.getBBox() : { x:0, y:0, width:0, height:0 };
            if (bbox.width <= 10 && bbox.height <= 10) return;
            const tag = origEl.tagName.toLowerCase();
            const compId = `component_${index}`;
            const group  = document.createElementNS(SVG_NS, 'g');
            group.setAttribute('class',            'component-group');
            group.setAttribute('data-component-id', compId);
            const cloneVisual = origEl.cloneNode(true);
            let   cloneHitbox;
            if (tag === 'g') {
                cloneHitbox = document.createElementNS(SVG_NS, 'rect');
                cloneHitbox.setAttribute('x',      String(bbox.x));
                cloneHitbox.setAttribute('y',      String(bbox.y));
                cloneHitbox.setAttribute('width',  String(bbox.width));
                cloneHitbox.setAttribute('height', String(bbox.height));
            } else { cloneHitbox = origEl.cloneNode(true); }
            cloneHitbox.setAttribute('fill-opacity',   '0');
            cloneHitbox.setAttribute('stroke-opacity',  '0');
            cloneHitbox.setAttribute('pointer-events',  'all');
            cloneHitbox.setAttribute('class',           'component-hitbox');
            cloneHitbox.setAttribute('data-component-id', compId);
            group.appendChild(cloneVisual); group.appendChild(cloneHitbox);
            origEl.parentNode.replaceChild(group, origEl);
            this.components.push({ element: cloneVisual, $element: $(cloneVisual),
                $hitbox: $(cloneHitbox), $group: $(group), id: compId, bbox,
                type: this.identifyComponentType($orig) });
        });
        console.log(`[Legacy] wires=${this.wires.length} comps=${this.components.length}`);

        // ── Component detection ─────────────────────────────
        this.$svgDisplay.find(
            'circle, rect, polygon, ellipse, path[d*="c"], path[d*="C"], path[d*="s"], path[d*="S"], g'
        ).not('.wire-group, .wire-group *, .component-group, .component-group *').each((index, origEl) => {
            const $orig = $(origEl);
            const bbox = origEl.getBBox ? origEl.getBBox() : { x: 0, y: 0, width: 0, height: 0 };
            if (bbox.width <= 10 && bbox.height <= 10) return;

            const tag = origEl.tagName.toLowerCase();
            const compId = `component_${index}`;

            const group = document.createElementNS(SVG_NS, 'g');
            group.setAttribute('class', 'component-group');
            group.setAttribute('data-component-id', compId);

            const cloneVisual = origEl.cloneNode(true);

            // Hitbox: groups get a bbox rect; shapes get a transparent clone
            let cloneHitbox;
            if (tag === 'g') {
                cloneHitbox = document.createElementNS(SVG_NS, 'rect');
                cloneHitbox.setAttribute('x', String(bbox.x));
                cloneHitbox.setAttribute('y', String(bbox.y));
                cloneHitbox.setAttribute('width', String(bbox.width));
                cloneHitbox.setAttribute('height', String(bbox.height));
            } else {
                cloneHitbox = origEl.cloneNode(true);
            }
            cloneHitbox.setAttribute('fill-opacity', '0');
            cloneHitbox.setAttribute('stroke-opacity', '0');
            cloneHitbox.setAttribute('pointer-events', 'all');
            cloneHitbox.setAttribute('class', 'component-hitbox');
            cloneHitbox.setAttribute('data-component-id', compId);

            group.appendChild(cloneVisual);
            group.appendChild(cloneHitbox);
            origEl.parentNode.replaceChild(group, origEl);

            this.components.push({
                element: cloneVisual,
                $element: $(cloneVisual),
                $hitbox: $(cloneHitbox),
                $group: $(group),
                id: compId,
                bbox,
                type: this.identifyComponentType($orig),
            });
        });

        console.log(`SVG analyzed: ${this.wires.length} wires, ${this.components.length} components`);
    },

    identifyComponentType($element) {
        const tag = $element[0].tagName.toLowerCase();
        const cls = $element.attr('class') || '';
        const id = $element.attr('id') || '';

        if (tag === 'circle') return 'connector';
        if (tag === 'rect') return 'module';
        if (cls.includes('resistor')) return 'resistor';
        if (cls.includes('capacitor')) return 'capacitor';
        if (cls.includes('switch')) return 'switch';
        if (id.includes('relay')) return 'relay';
        return 'component';
    },

    // ── Selection helpers ────────────────────────────────────

    handleTap(event) {
        const target = event.target;
        if (target && target !== this.$svgContainer[0] && target !== this.$svgWrapper[0]) {
            this.selectElement($(target));
        }
    },

    selectElement($element) {
        this.selectedElements = [$element[0]];
        $element.addClass('selected-element');
        this.showElementInfo($element);
        if (this.isWire($element)) {
            this.highlightConnectedComponents($element);
        }
    },

    // isWire lives in geometryEngine.js. A second copy here used to shadow it —
    // this file loads later, so the prototype ended up with the older version,
    // the one that compares against w.element only. Every click lands on the
    // invisible .wire-hitbox rather than the visual path, so that version
    // answered "no" for every wire a user could actually click.

    showElementInfo($element) {
        const tag = $element[0].tagName;
        const cls = $element.attr('class') || 'None';
        const id = $element.attr('id') || 'None';
        this.showToast(`${tag}  cls:${cls}  id:${id}`, 'success');
    },

    clearSelection() {
        this.selectedElements.forEach(el => $(el).removeClass('selected-element'));
        this.selectedElements = [];
        this.clearAllHighlights();
    },

    highlightConnectedComponents($wireElement) {
        const wireEndPoints = this.getWireEndPoints($wireElement);
        this.components.forEach(comp => {
            const b = comp.bbox;
            wireEndPoints.forEach(pt => {
                const dist = Math.hypot(pt.x - (b.x + b.width / 2), pt.y - (b.y + b.height / 2));
                if (dist < 20) comp.$element.addClass('component-highlight');
            });
        });
    },

    getWireEndPoints($wire) {
        const el = $wire[0];
        const pts = [];
        if (el.tagName === 'line') {
            pts.push(
                { x: parseFloat($wire.attr('x1')), y: parseFloat($wire.attr('y1')) },
                { x: parseFloat($wire.attr('x2')), y: parseFloat($wire.attr('y2')) }
            );
        } else if (el.tagName === 'path') {
            const m = ($wire.attr('d') || '').match(/[\d.]+/g);
            if (m && m.length >= 4) {
                pts.push(
                    { x: parseFloat(m[0]), y: parseFloat(m[1]) },
                    { x: parseFloat(m[m.length - 2]), y: parseFloat(m[m.length - 1]) }
                );
            }
        }
        return pts;
    },

    highlightElement($element, on) {
        if (on) {
            // Use CSS classes — never touch inline styles so showConnections() colors survive hover
            const isCanvasOverlay = $element.hasClass('canvas-wire-overlay') ||
                $element.hasClass('canvas-component-overlay');
            $element.addClass(isCanvasOverlay ? 'canvas-overlay-hover' : 'wire-hover');
        } else {
            $element.removeClass('wire-hover canvas-overlay-hover');
        }
    },

    // ── Canvas-mode wire and component detection ──────────────
    analyzeCanvasDiagram(canvas) {
        const W = canvas.width, H = canvas.height;
        const NS = 'http://www.w3.org/2000/svg';
        const { data } = canvas.getContext('2d').getImageData(0, 0, W, H);

        // 1. Binary image; 1 = dark pixel
        const bin = new Uint8Array(W * H);
        const DARK = 200; // luminance threshold
        for (let i = 0; i < W * H; i++) {
            if (data[i * 4 + 3] < 128) continue; // transparent = light
            bin[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) < DARK ? 1 : 0;
        }

        // 2. Scan rows/columns for continuous dark pixel runs ≥ MIN_LEN
        const MIN_LEN = Math.max(20, Math.round(W * 0.015));
        const hRuns = [], vRuns = [];

        for (let y = 0; y < H; y++) {
            let s = -1;
            for (let x = 0; x <= W; x++) {
                const dark = x < W && bin[y * W + x];
                if (dark && s < 0) { s = x; }
                else if (!dark && s >= 0) { if (x - s >= MIN_LEN) hRuns.push({ pos: y, a: s, b: x - 1 }); s = -1; }
            }
        }
        for (let x = 0; x < W; x++) {
            let s = -1;
            for (let y = 0; y <= H; y++) {
                const dark = y < H && bin[y * W + x];
                if (dark && s < 0) { s = y; }
                else if (!dark && s >= 0) { if (y - s >= MIN_LEN) vRuns.push({ pos: x, a: s, b: y - 1 }); s = -1; }
            }
        }

        // 3. Cluster nearby parallel runs → one representative line per wire stroke
        const MAX_W = 5; // max stroke width in pixels
        const cluster = (runs) => {
            if (!runs.length) return [];
            runs.sort((a, b) => a.pos - b.pos || a.a - b.a);
            const groups = [];
            for (const r of runs) {
                let placed = false;
                for (const g of groups) {
                    if (Math.abs(g.pos - r.pos) <= MAX_W && r.a <= g.b + MAX_W && r.b >= g.a - MAX_W) {
                        g.posSum += r.pos; g.n++;
                        g.pos = g.posSum / g.n;
                        g.a = Math.min(g.a, r.a); g.b = Math.max(g.b, r.b);
                        placed = true; break;
                    }
                }
                if (!placed) groups.push({ pos: r.pos, posSum: r.pos, n: 1, a: r.a, b: r.b });
            }
            return groups.map(g => ({ pos: Math.round(g.pos), a: g.a, b: g.b }));
        };

        const hLines = cluster(hRuns);
        const vLines = cluster(vRuns);

        // 4. Sample actual stroke colour from the canvas pixels at wire midpoint
        const sampleColor = (x, y) => {
            const i = (Math.clamp ? Math.clamp(Math.round(y), 0, H - 1) : Math.min(Math.max(Math.round(y), 0), H - 1)) * W
                + Math.min(Math.max(Math.round(x), 0), W - 1);
            return `rgb(${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]})`;
        };

        // 5. Build invisible SVG <line> overlays for each detected wire
        const allSegs = [
            ...hLines.map(l => ({ x1: l.a, y1: l.pos, x2: l.b, y2: l.pos, color: sampleColor((l.a + l.b) / 2, l.pos) })),
            ...vLines.map(l => ({ x1: l.pos, y1: l.a, x2: l.pos, y2: l.b, color: sampleColor(l.pos, (l.a + l.b) / 2) })),
        ];

        allSegs.forEach((seg, idx) => {
            const id = `wire_${this.wires.length + idx}`;
            const group = document.createElementNS(NS, 'g');
            group.setAttribute('class', 'wire-group');
            group.setAttribute('data-wire-id', id);

            const visual = document.createElementNS(NS, 'line');
            visual.setAttribute('x1', String(seg.x1)); visual.setAttribute('y1', String(seg.y1));
            visual.setAttribute('x2', String(seg.x2)); visual.setAttribute('y2', String(seg.y2));
            visual.setAttribute('stroke', seg.color);
            visual.setAttribute('stroke-width', '3');
            visual.setAttribute('class', 'canvas-wire-overlay');

            const hitbox = document.createElementNS(NS, 'line');
            hitbox.setAttribute('x1', String(seg.x1)); hitbox.setAttribute('y1', String(seg.y1));
            hitbox.setAttribute('x2', String(seg.x2)); hitbox.setAttribute('y2', String(seg.y2));
            hitbox.setAttribute('stroke', '#000');
            hitbox.setAttribute('stroke-width', '12');
            hitbox.setAttribute('fill', 'none');
            hitbox.setAttribute('class', 'wire-hitbox canvas-wire-hitbox');
            hitbox.setAttribute('data-wire-id', id);

            group.appendChild(visual);
            group.appendChild(hitbox);
            this._contentRoot.appendChild(group);

            this.wires.push({
                element: visual, $element: $(visual),
                $hitbox: $(hitbox), $group: $(group),
                id, color: seg.color, width: 3,
            });
        });

        // 6. BFS flood-fill: find connected dark regions not covered by wires → components
        const wireMask = new Uint8Array(W * H);
        for (const l of hLines) for (let x = l.a; x <= l.b; x++) wireMask[l.pos * W + x] = 1;
        for (const l of vLines) for (let y = l.a; y <= l.b; y++) wireMask[y * W + l.pos] = 1;

        const visited = new Uint8Array(W * H);
        const MIN_DIM = 12, MAX_PIXELS = 40000;

        for (let sy = 0; sy < H; sy++) {
            for (let sx = 0; sx < W; sx++) {
                const si = sy * W + sx;
                if (!bin[si] || wireMask[si] || visited[si]) continue;

                const stack = [si];
                visited[si] = 1;
                let minX = sx, maxX = sx, minY = sy, maxY = sy, count = 0;

                while (stack.length && count < MAX_PIXELS) {
                    const ci = stack.pop();
                    const cx = ci % W, cy = (ci / W) | 0;
                    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
                    count++;
                    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                        const nx = cx + dx, ny = cy + dy;
                        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                        const ni = ny * W + nx;
                        if (!bin[ni] || visited[ni]) continue;
                        visited[ni] = 1;
                        stack.push(ni);
                    }
                }

                const bw = maxX - minX, bh = maxY - minY;
                if (bw < MIN_DIM && bh < MIN_DIM) continue;

                const ar = bw > 0 ? bh / bw : 1;
                const fillRatio = count / ((bw + 1) * (bh + 1));
                const isCircular = ar > 0.6 && ar < 1.6 && fillRatio > 0.4;
                const type = isCircular ? 'connector' : 'module';
                const id = `component_${this.components.length}`;

                let el;
                if (isCircular) {
                    el = document.createElementNS(NS, 'circle');
                    el.setAttribute('cx', String((minX + maxX) / 2));
                    el.setAttribute('cy', String((minY + maxY) / 2));
                    el.setAttribute('r', String(Math.max(bw, bh) / 2));
                } else {
                    el = document.createElementNS(NS, 'rect');
                    el.setAttribute('x', String(minX)); el.setAttribute('y', String(minY));
                    el.setAttribute('width', String(bw)); el.setAttribute('height', String(bh));
                }
                el.setAttribute('fill', 'transparent');
                el.setAttribute('stroke', 'none');
                el.setAttribute('class', `canvas-component-overlay canvas-${type}`);
                el.setAttribute('data-component-id', id);
                this._contentRoot.appendChild(el);

                this.components.push({
                    element: el, $element: $(el), id,
                    bbox: { x: minX, y: minY, width: bw, height: bh }, type,
                });
            }
        }

        console.log(`Canvas analyzed: ${this.wires.length} wires, ${this.components.length} components`);
    },
});
