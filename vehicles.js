/* ================================================================
   车辆 · 里程 · 每公里花费
   ---------------------------------------------------------------
   职责：
     1. 多辆车（燃油 / 纯电 / 混动）的增删改与切换
     2. 里程表读数录入（总里程 + 混动可选纯电里程）
     3. 按当前车辆过滤记录，并计算「每公里花费」
   依赖 index.html 里定义的：DB / records / currentUser / showToast /
                            formatDate / getTodayStr / renderAll
   ================================================================ */
(function () {
    'use strict';

    const TYPES = {
        fuel: { label: '燃油车', icon: '⛽', kinds: ['gas'] },
        ev: { label: '纯电车', icon: '⚡', kinds: ['electric'] },
        hybrid: { label: '混动车', icon: '🔋', kinds: ['electric', 'gas'] },
    };

    // 车辆/里程面板里的表单控件：原来的输入框样式都写在 .add-form .form-row 下面，
    // 新面板不在那个作用域里，所以这里补一套一致的样式（挂在 <style> 上，避免再改构建）。
    const FORM_CSS = `
        .vehicle-form input,
        .mileage-form input {
            width: 100%;
            border: 1.5px solid #e2e8f0;
            background: #fff;
            border-radius: 12px;
            padding: 11px 13px;
            font-size: 15px;
            font-family: inherit;
            color: var(--text);
            outline: none;
            transition: border-color .18s, box-shadow .18s;
        }
        .vehicle-form input:focus,
        .mileage-form input:focus {
            border-color: var(--primary-e);
            box-shadow: 0 0 0 3px rgba(59,130,246,.12);
        }
        .vehicle-form input::placeholder,
        .mileage-form input::placeholder { color: #94a3b8; }
        .vehicle-form .submit-btn,
        .mileage-form .submit-btn {
            border: none;
            border-radius: 12px;
            padding: 12px;
            font-size: 15px;
            font-weight: 700;
            font-family: inherit;
            color: #fff;
            background: linear-gradient(135deg, #3b82f6, #6366f1);
            box-shadow: 0 4px 14px rgba(59,130,246,.28);
            cursor: pointer;
        }
        .vehicle-form .submit-btn:active,
        .mileage-form .submit-btn:active { transform: scale(.985); }
        .vehicle-form > input { margin-bottom: 10px; }
        .mileage-form > input { margin-bottom: 2px; }
        .vehicle-form .vf-row { margin: 10px 0 4px; }
        .vehicle-form .vf-label { font-size: 12.5px; color: var(--text-secondary); font-weight: 600; }
        .vehicle-form .vf-hint { font-size: 11px; color: #94a3b8; line-height: 1.5; margin-bottom: 8px; }
        /* 里程面板的分段、提示、勾选框样式统一写在 index.html 主样式表里。
           放在这个外部脚本里会被缓存旧版本覆盖，导致勾选框掉行、提示压框。 */
    `;

    (function injectStyles() {
        const el = document.createElement('style');
        el.id = 'vehicle-styles';
        el.textContent = FORM_CSS;
        document.head.appendChild(el);
    })();


    let currentVehicleId = '';        // '' 表示「全部车辆」
    let editingVehicleId = '';        // 车辆表单正在编辑哪辆；空串=新增

    const $ = (s) => document.querySelector(s);
    const byId = (id) => document.getElementById(id);
    const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

    function toast(msg, ms) {
        if (typeof showToast === 'function') showToast(msg, ms);
    }

    // ───────────────────────── 基础查询 ─────────────────────────
    function savedOrder() {
        const meta = typeof window.__readMeta === 'function' ? window.__readMeta() : null;
        return meta && Array.isArray(meta.vehicle_order) ? meta.vehicle_order : [];
    }

    function vehicles() {
        const list = DB.visible('vehicles').slice();
        const order = savedOrder();
        if (!order.length) {
            return list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        }
        const rank = (v) => {
            const i = order.indexOf(v.id);
            return i < 0 ? 9999 : i;
        };
        return list.sort((a, b) => rank(a) - rank(b) || (a.createdAt || 0) - (b.createdAt || 0));
    }

    /** 上移 / 下移（-1 上移，+1 下移），顺序写进账号设置 */
    function moveVehicle(id, dir) {
        const list = vehicles();
        const i = list.findIndex((v) => v.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return false;
        const t = list[i];
        list[i] = list[j];
        list[j] = t;
        const ids = list.map((v) => v.id);
        if (typeof window.__updateMeta === 'function') {
            window.__updateMeta({ vehicle_order: ids });
        }
        renderVehicleBar();
        renderVehicleList();
        if (typeof renderPerKm === 'function') renderPerKm();
        return true;
    }

    function vehicleById(id) {
        return vehicles().find((v) => v.id === id) || null;
    }

    function currentVehicle() {
        if (!currentVehicleId) return null;
        return vehicleById(currentVehicleId);
    }

    function isAllMode() {
        return !currentVehicleId;
    }

    /** 记录属于哪辆车：没标记的（老数据）归到第一辆 */
    function resolveVehicleId(rec) {
        if (rec && rec.vehicleId) return rec.vehicleId;
        const list = vehicles();
        if (!list.length) return '';
        // 没有归属的记录：优先挂到「类型能装下它」的车，别一律塞给第一辆
        if (rec && rec.type) {
            const match = list.find((v) => (TYPES[v.type] || TYPES.hybrid).kinds.indexOf(rec.type) >= 0);
            if (match) return match.id;
        }
        return list[0].id;
    }

    /** 当前范围（全部 / 某辆车）是否能记这类账 */
    function canRecordKind(kind) {
        const list = vehicles();
        if (!list.length) return true;
        if (currentVehicleId) {
            const v = vehicleById(currentVehicleId);
            if (!v) return true;
            return (TYPES[v.type] || TYPES.hybrid).kinds.indexOf(kind) >= 0;
        }
        return list.some((v) => (TYPES[v.type] || TYPES.hybrid).kinds.indexOf(kind) >= 0);
    }

    /** 能记这类账的车（用于「全部」视图下选择归属） */
    function candidatesFor(kind) {
        return vehicles().filter((v) => (TYPES[v.type] || TYPES.hybrid).kinds.indexOf(kind) >= 0);
    }

    /** 某车型允许的记账类型 */
    function allowedKinds(type) {
        return (TYPES[type] || TYPES.hybrid).kinds;
    }

    function typeLabel(type) {
        return (TYPES[type] || TYPES.hybrid).label;
    }

    /** 扫描「记录类型 vs 所属车辆类型」冲突 */
    function conflicts() {
        const out = [];
        DB.visibleRecords().forEach((r) => {
            const v = vehicleById(resolveVehicleId(r));
            if (!v) return;
            if (allowedKinds(v.type).indexOf(r.type) < 0) out.push({ rec: r, vehicle: v });
        });
        return out;
    }

    /** 记住「上次选中的车」，刷新后不跳回「全部」 */
    function vehicleKey() {
        return (typeof DB !== 'undefined' ? DB.key() : 'guest') + '_veh';
    }

    function saveSelection() {
        try {
            localStorage.setItem(vehicleKey(), currentVehicleId || '');
        } catch (e) { /* 忽略 */ }
    }

    // ───────────────── 记账后自动提醒记里程 ─────────────────
    function autoOdoKey() {
        return (typeof DB !== 'undefined' ? DB.key() : 'guest') + '_autoodo';
    }

    function autoOdoEnabled() {
        try {
            return localStorage.getItem(autoOdoKey()) !== 'off';
        } catch (e) {
            return true;
        }
    }

    function paintAutoOdo() {
        const box = byId('odoAutoToggle');
        if (!box) return;
        box.checked = autoOdoEnabled();
    }

    function setAutoOdo(on) {
        try {
            localStorage.setItem(autoOdoKey(), on ? 'on' : 'off');
        } catch (e) { /* 忽略 */ }
        paintAutoOdo();
    }

    /** 记完一笔账后调用：关掉记账面板，顺手弹出里程面板（可跳过） */
    function afterAddRecord(date) {
        if (!autoOdoEnabled()) return;
        if (!currentVehicleId) return; // 「全部车辆」下不知道记给哪辆车
        if (typeof closeSheet === 'function') closeSheet();
        setTimeout(() => {
            if (isAllMode()) return;
            openMileageSheet(date);
        }, 280);
    }

    function restoreSelection() {
        let saved = '';
        try {
            saved = localStorage.getItem(vehicleKey()) || '';
        } catch (e) { /* 忽略 */ }
        const list = vehicles();
        if (saved && list.some((v) => v.id === saved)) {
            currentVehicleId = saved;
            return;
        }
        currentVehicleId = list.length === 1 ? list[0].id : '';
    }

    /** 首次进入且一辆车都没有时，建一辆默认车（id 与服务端迁移脚本保持一致，不会重复） */
    function ensureDefaultVehicle() {
        restoreSelection();
        if (DB.visible('vehicles').length) {
            if (!currentVehicleId && vehicles().length === 1) currentVehicleId = vehicles()[0].id;
            return;
        }
        // 没有账号（未登录）或完全没有数据时不自动建
        const hasRecords = DB.visibleRecords().length > 0;
        if (!hasRecords || !currentUser) return;

        const id = 'v_' + currentUser.id;
        const now = Date.now();
        const v = {
            id,
            name: '我的车',
            type: 'hybrid',
            note: '旧数据自动归入，可在车辆管理里改名和改类型',
            startOdometer: 0,
            createdAt: now,
            updatedAt: now,
            dirty: 1,
            deleted: 0,
        };
        const all = DB.table('vehicles');
        all.push(v);
        DB.saveTable('vehicles', all);
        currentVehicleId = id;
    }

    // ───────────────────────── 车辆切换 ─────────────────────────
    function setCurrentVehicle(id) {
        currentVehicleId = id;
        saveSelection();
        if (typeof records !== 'undefined') records = loadRecords();
        applyTypeConstraints();
        if (typeof renderAll === 'function') renderAll();
        if (typeof scheduleSync === 'function') scheduleSync(3000);
    }

    function renderVehicleBar() {
        const bar = byId('vehicleChips');
        if (!bar) return;
        const list = vehicles();
        const parts = [];

        if (list.length > 1) {
            parts.push(
                `<button class="vchip${isAllMode() ? ' active' : ''}" data-id="">` +
                `<span class="vchip-icon">🗂</span><span class="vchip-name">全部</span></button>`
            );
        }

        list.forEach((v) => {
            const t = TYPES[v.type] || TYPES.hybrid;
            const active = (!isAllMode() && currentVehicleId === v.id) || (isAllMode() && list.length === 1);
            parts.push(
                `<button class="vchip${active ? ' active' : ''}" data-id="${v.id}">` +
                `<span class="vchip-icon">${t.icon}</span><span class="vchip-name">${escapeHtml(v.name)}</span></button>`
            );
        });

        if (!list.length) {
            parts.push(`<button class="vchip empty" data-id="__add__"><span class="vchip-icon">＋</span><span class="vchip-name">添加车辆</span></button>`);
        }

        bar.innerHTML = parts.join('');
        bar.querySelectorAll('.vchip').forEach((el) => {
            el.addEventListener('click', () => {
                const id = el.dataset.id;
                if (id === '__add__') return openVehicleSheet();
                if (id === currentVehicleId) return;
                setCurrentVehicle(id);
            });
        });
    }

    // ───────────────────────── 记录表单跟随车型 ─────────────────────────
    function applyTypeConstraints() {
        const v = currentVehicle();
        const allowed = v ? (TYPES[v.type] || TYPES.hybrid).kinds : ['electric', 'gas'];
        document.querySelectorAll('#typeToggle button').forEach((btn) => {
            const kind = btn.dataset.type;
            btn.style.display = allowed.includes(kind) ? '' : 'none';
        });
        if (typeof currentType !== 'undefined' && !allowed.includes(currentType)) {
            const next = allowed[0];
            if (typeof updateTypeToggle === 'function') updateTypeToggle(next);
        }
    }

    // ───────────────────────── 车辆管理面板 ─────────────────────────
    function openVehicleSheet(editId) {
        editingVehicleId = editId || '';
        renderVehicleList();
        fillVehicleForm();
        byId('vehicleSheet').classList.add('active');
        byId('vehicleOverlay').classList.add('active');
        if (window.__ovEnter) window.__ovEnter();
    }

    function closeVehicleSheet() {
        const wasOpen = byId('vehicleSheet').classList.contains('active');
        byId('vehicleSheet').classList.remove('active');
        byId('vehicleOverlay').classList.remove('active');
        editingVehicleId = '';
        if (wasOpen && window.__ovLeave) window.__ovLeave();
    }

    function renderVehicleList() {
        const box = byId('vehicleList');
        const list = vehicles();
        if (!list.length) {
            box.innerHTML = `<div class="empty-msg">还没有车辆，先在下面添加一辆</div>`;
            return;
        }
        box.innerHTML = list
            .map((v, idx) => {
                const t = TYPES[v.type] || TYPES.hybrid;
                const cnt = DB.visibleRecords().filter((r) => resolveVehicleId(r) === v.id).length;
                return `<div class="vrow">
                    <div class="vrow-main">
                        <span class="vrow-icon">${t.icon}</span>
                        <div>
                            <div class="vrow-name">${escapeHtml(v.name)}</div>
                            <div class="vrow-sub">${t.label} · ${cnt} 条记录</div>
                        </div>
                    </div>
                    <div class="vrow-ops">
                        <button data-act="up" data-id="${v.id}" class="sort-btn"${idx === 0 ? ' disabled' : ''}>↑</button>
                        <button data-act="down" data-id="${v.id}" class="sort-btn"${idx === list.length - 1 ? ' disabled' : ''}>↓</button>
                        <button data-act="edit" data-id="${v.id}">编辑</button>
                        <button data-act="del" data-id="${v.id}" class="danger">删除</button>
                    </div>
                </div>`;
            })
            .join('');

        box.querySelectorAll('button[data-act]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.act;
                if (act === 'edit') openVehicleSheet(btn.dataset.id);
                else if (act === 'up') moveVehicle(btn.dataset.id, -1);
                else if (act === 'down') moveVehicle(btn.dataset.id, 1);
                else deleteVehicle(btn.dataset.id);
            });
        });
    }

    function fillVehicleForm() {
        const v = editingVehicleId ? vehicleById(editingVehicleId) : null;
        byId('vehicleFormTitle').textContent = v ? '编辑车辆' : '添加车辆';
        byId('vehName').value = v ? v.name : '';
        byId('vehStartOdo').value = v && v.startOdometer ? v.startOdometer : '';
        setVehicleType(v ? v.type : 'fuel');
        setFillMode(v ? (v.fillMode || 'full') : 'full');
        if (byId('vehL100')) byId('vehL100').value = v && v.compareConsumption ? v.compareConsumption : '';
        if (byId('vehPrice')) byId('vehPrice').value = v && v.fuelPrice ? v.fuelPrice : '';
        byId('vehSubmit').textContent = v ? '保存修改' : '添加';
        byId('vehCancel').style.display = v ? '' : 'none';
    }

    function setVehicleType(type) {
        byId('vehicleForm').dataset.type = type;
        document.querySelectorAll('#vehTypeToggle button').forEach((b) => {
            b.classList.toggle('active', b.dataset.type === type);
        });
        // 纯电车没有加油，隐藏「加油习惯」
        const row = byId('vehFillRow');
        const hint = byId('vehFillHint');
        const show = type !== 'ev';
        if (row) row.style.display = show ? '' : 'none';
        if (hint) hint.style.display = show ? '' : 'none';
        // 纯电车才需要「对比油车」这两个值
        const cmpRow = byId('vehCompareRow');
        const cmpHint = byId('vehCompareHint');
        if (cmpRow) cmpRow.style.display = type === 'ev' ? '' : 'none';
        if (cmpHint) cmpHint.style.display = type === 'ev' ? '' : 'none';
    }

    function setFillMode(mode) {
        const value = mode === 'fixed' ? 'fixed' : 'full';
        byId('vehicleForm').dataset.fill = value;
        document.querySelectorAll('#vehFillToggle button').forEach((b) => {
            b.classList.toggle('active', b.dataset.fill === value);
        });
    }

    function saveVehicle() {
        const name = byId('vehName').value.trim();
        const type = byId('vehicleForm').dataset.type || 'hybrid';
        const fillMode = byId('vehicleForm').dataset.fill === 'fixed' ? 'fixed' : 'full';
        const start = Number(byId('vehStartOdo').value) || 0;
        const compareConsumption = Number(byId('vehL100') && byId('vehL100').value) || 0;
        const fuelPrice = Number(byId('vehPrice') && byId('vehPrice').value) || 0;
        if (!name) { toast('请填写车辆名称'); return; }

        const all = DB.table('vehicles');
        const now = Date.now();
        const existing = editingVehicleId ? all.find((x) => x.id === editingVehicleId) : null;

        if (existing && existing.type !== type) {
            // 车型改小（混动→燃油/电车）时，历史记录可能对不上，先确认
            const kinds = allowedKinds(type);
            const bad = DB.visibleRecords().filter(
                (r) => resolveVehicleId(r) === existing.id && kinds.indexOf(r.type) < 0
            );
            if (bad.length) {
                const what = bad.some((r) => r.type === 'electric') ? '充电' : '加油';
                const ok = confirm(
                    '「' + name + '」有 ' + bad.length + ' 条' + what + '记录，改成「' + typeLabel(type) + '」后这些记录没有意义。\n\n' +
                    '继续会把它们删除（其他设备也会同步删除）。'
                );
                if (!ok) return;
                const recs = DB.table('records');
                const ts = Date.now();
                let removed = 0;
                bad.forEach((b) => {
                    const t = recs.find((x) => x.id === b.id);
                    if (t) { t.deleted = 1; t.updatedAt = ts; t.dirty = 1; removed++; }
                });
                DB.saveTable('records', recs);
                records = loadRecords();
                if (removed) toast('已删除 ' + removed + ' 条冲突记录', 2400);
            }
        }

        if (existing) {
            existing.name = name;
            existing.type = type;
            existing.fillMode = fillMode;
            existing.compareConsumption = compareConsumption;
            existing.fuelPrice = fuelPrice;
            existing.startOdometer = start;
            existing.updatedAt = now;
            existing.dirty = 1;
            toast('已保存');
        } else {
            const id = uid();
            all.push({
                id, name, type, note: '',
                fillMode: fillMode,
                compareConsumption: compareConsumption,
                fuelPrice: fuelPrice,
                startOdometer: start,
                createdAt: now, updatedAt: now, dirty: 1, deleted: 0,
            });
            currentVehicleId = id;
            saveSelection();
            toast('已添加「' + name + '」');
        }

        DB.saveTable('vehicles', all);
        editingVehicleId = '';
        records = loadRecords();
        applyTypeConstraints();
        renderVehicleList();
        fillVehicleForm();
        if (typeof renderAll === 'function') renderAll();
        if (typeof scheduleSync === 'function') scheduleSync(800);
    }

    // ───────────────────────── 数据检查（类型冲突） ─────────────────────────
    let conflictToastShown = false;

    function refreshConflictUI() {
        const list = conflicts();
        const row = byId('acctConflictRow');
        const val = byId('acctConflict');
        if (row) row.style.display = list.length ? '' : 'none';
        if (val) val.textContent = list.length + ' 条';
        if (list.length && !conflictToastShown && typeof toast === 'function') {
            conflictToastShown = true;
            setTimeout(() => toast('发现 ' + list.length + ' 条记录与车型不符，账号面板可处理', 3200), 1500);
        }
    }

    function renderConflictList() {
        const box = byId('conflictList');
        if (!box) return;
        const list = conflicts();
        if (!list.length) {
            box.innerHTML = '<div class="empty-msg">没有发现冲突，数据是干净的</div>';
            return;
        }
        box.innerHTML = list
            .slice()
            .sort((a, b) => (a.rec.date < b.rec.date ? 1 : -1))
            .map(({ rec, vehicle }) => {
                const icon = rec.type === 'electric' ? '⚡' : '⛽';
                const kind = rec.type === 'electric' ? '充电' : '加油';
                return '<div class="orow">' +
                    '<div class="orow-main">' +
                    '<div class="orow-amount">' + icon + ' ' + kind + ' ¥' + (Number(rec.amount) || 0).toFixed(2) + '</div>' +
                    '<div class="orow-sub">' + rec.date + ' · 挂在「' + vehicle.name + '」(' + typeLabel(vehicle.type) + ')' +
                    (rec.note ? ' · ' + rec.note : '') + '</div>' +
                    '</div>' +
                    '<button class="orow-del" data-del="' + rec.id + '">✕</button>' +
                    '</div>';
            })
            .join('');
        box.querySelectorAll('button[data-del]').forEach((btn) => {
            btn.addEventListener('click', () => deleteConflict(btn.dataset.del));
        });
    }

    function deleteConflict(id) {
        const recs = DB.table('records');
        const target = recs.find((x) => x.id === id);
        if (!target) return;
        const now = Date.now();
        target.deleted = 1;
        target.updatedAt = now;
        target.dirty = 1;
        DB.saveTable('records', recs);
        records = loadRecords();
        if (typeof renderAll === 'function') renderAll();
        if (typeof scheduleSync === 'function') scheduleSync(500);
        renderConflictList();
        toast('已删除这条冲突记录', 2000);
    }

    function openConflictSheet() {
        renderConflictList();
        byId('conflictSheet').classList.add('active');
        byId('conflictOverlay').classList.add('active');
        if (window.__ovEnter) window.__ovEnter();
    }

    function closeConflictSheet() {
        const wasOpen = byId('conflictSheet').classList.contains('active');
        byId('conflictSheet').classList.remove('active');
        byId('conflictOverlay').classList.remove('active');
        if (wasOpen && window.__ovLeave) window.__ovLeave();
    }

    function deleteVehicle(id) {
        const v = vehicleById(id);
        if (!v) return;
        const cnt = DB.visibleRecords().filter((r) => resolveVehicleId(r) === id).length;
        const msg = cnt
            ? `「${v.name}」下有 ${cnt} 条记录，删除车辆会**连同这些记录一起删除**（其他设备也会同步删除）。确定吗？`
            : `确定删除「${v.name}」吗？`;
        if (!confirm(msg)) return;

        const now = Date.now();
        const vs = DB.table('vehicles');
        const target = vs.find((x) => x.id === id);
        if (target) { target.deleted = 1; target.updatedAt = now; target.dirty = 1; }
        DB.saveTable('vehicles', vs);

        // 该车的记录与里程一起标记删除
        const recs = DB.table('records');
        recs.forEach((r) => {
            if (resolveVehicleId(r) === id) { r.deleted = 1; r.updatedAt = now; r.dirty = 1; }
        });
        DB.saveTable('records', recs);

        const odos = DB.table('odometer');
        odos.forEach((o) => {
            if (o.vehicleId === id) { o.deleted = 1; o.updatedAt = now; o.dirty = 1; }
        });
        DB.saveTable('odometer', odos);

        if (currentVehicleId === id) {
            currentVehicleId = '';
            saveSelection();
        }
        records = loadRecords();
        renderVehicleList();
        fillVehicleForm();
        if (typeof renderAll === 'function') renderAll();
        if (typeof scheduleSync === 'function') scheduleSync(800);
        toast('已删除');
    }

    // ───────────────────────── 里程 ─────────────────────────
    function odometerOf(vehicleId) {
        return DB.visible('odometer')
            .filter((o) => o.vehicleId === vehicleId)
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
    }

    function openMileageSheet(dateOverride) {
        const v = currentVehicle();
        if (!v) { toast('先选择一辆车'); return; }
        byId('odoDate').value = dateOverride || (typeof getTodayStr === 'function' ? getTodayStr() : new Date().toISOString().slice(0, 10));
        byId('odoTotal').value = '';
        byId('odoEv').value = '';
        if (byId('odoFuel')) byId('odoFuel').value = '';
        byId('odoEvField').style.display = v.type === 'hybrid' ? '' : 'none';
        byId('odoEvHint').style.display = v.type === 'hybrid' ? '' : 'none';
        byId('odoEvHint').textContent = '两个填一个即可，另一个自动算（纯电 + 燃油 = 总里程）';
        renderMileageList();
        paintAutoOdo();
        byId('mileageSheet').classList.add('active');
        byId('mileageOverlay').classList.add('active');
        if (window.__ovEnter) window.__ovEnter();
        setTimeout(() => byId('odoTotal').focus(), 260);
    }

    function closeMileageSheet() {
        const wasOpen = byId('mileageSheet').classList.contains('active');
        byId('mileageSheet').classList.remove('active');
        byId('mileageOverlay').classList.remove('active');
        if (wasOpen && window.__ovLeave) window.__ovLeave();
    }

    function renderMileageList() {
        const v = currentVehicle();
        const box = byId('mileageList');
        if (!v) { box.innerHTML = ''; return; }
        const list = odometerOf(v.id).slice().reverse();
        if (!list.length) {
            box.innerHTML = `<div class="empty-msg">还没有里程记录<br/><span style="font-size:12px;opacity:.7">记一次当前总里程，就能算出每公里花费</span></div>`;
            return;
        }
        box.innerHTML = list
            .slice(0, 30)
            .map((o) => {
                const ev = o.evKm != null && o.evKm !== '' ? ` · 纯电 ${o.evKm}` : '';
                const fuel = o.evKm != null && o.evKm !== '' ? ` · 燃油 ${Number(o.totalKm) - Number(o.evKm)}` : '';
                return `<div class="orow">
                    <div>
                        <div class="orow-km">${o.totalKm} km</div>
                        <div class="orow-sub">${o.date}${ev}${fuel}</div>
                    </div>
                    <button class="orow-del" data-id="${o.id}" title="删除">✕</button>
                </div>`;
            })
            .join('');
        box.querySelectorAll('.orow-del').forEach((btn) => {
            btn.addEventListener('click', () => deleteOdometer(btn.dataset.id));
        });
    }

    /** 里程表单的实时提示：说明另一个字段会被算成多少 */
    function updateOdoPreview() {
        const hint = byId('odoEvHint');
        if (!hint) return;
        const v = currentVehicle();
        if (!v || v.type !== 'hybrid') return;

        const total = Number(byId('odoTotal').value);
        const evRaw = byId('odoEv').value;
        const fuelEl = byId('odoFuel');
        const fuelRaw = fuelEl ? fuelEl.value : '';

        if (!total || total <= 0) {
            hint.textContent = '两个填一个即可，另一个自动算（纯电 + 燃油 = 总里程）';
            return;
        }
        if (evRaw !== '' && fuelRaw === '') {
            hint.textContent = '燃油里程将记为 ' + Math.max(0, total - Number(evRaw)) + ' km';
        } else if (fuelRaw !== '' && evRaw === '') {
            hint.textContent = '纯电里程将记为 ' + Math.max(0, total - Number(fuelRaw)) + ' km';
        } else if (evRaw !== '' && fuelRaw !== '') {
            const sum = Number(evRaw) + Number(fuelRaw);
            hint.textContent = Math.abs(sum - total) <= 1
                ? '纯电 ' + evRaw + ' + 燃油 ' + fuelRaw + ' = ' + total + ' km ✓'
                : '两个都填了，合计 ' + sum + ' km，与总里程 ' + total + ' km 不一致';
        } else {
            hint.textContent = '两个填一个即可，另一个自动算（纯电 + 燃油 = 总里程）';
        }
    }

    function saveOdometer() {
        const v = currentVehicle();
        if (!v) return;
        const date = byId('odoDate').value;
        const totalRaw = Number(byId('odoTotal').value);
        const totalKm = Math.round(totalRaw);
        const evRaw = byId('odoEv') ? byId('odoEv').value : '';
        const fuelRaw = byId('odoFuel') ? byId('odoFuel').value : '';
        let evKm = evRaw === '' ? null : Number(evRaw);

        if (!date) { toast('请选择日期'); return; }
        if (!Number.isFinite(totalKm) || totalKm <= 0) { toast('请填写有效的总里程'); return; }

        const fuelKm = fuelRaw === '' ? null : Number(fuelRaw);

        if (v.type === 'hybrid') {
            // 纯电 / 燃油 只需填一个，另一个由总里程反算
            if (evKm == null && fuelKm != null) evKm = totalKm - fuelKm;
            if (evKm != null && fuelKm != null && Math.abs(evKm + fuelKm - totalKm) > 1) {
                toast('纯电 + 燃油 应等于总里程（' + totalKm + ' km）');
                return;
            }
            // 数据库里里程是整数列，这里统一取整，避免小数导致同步失败
            if (evKm != null) evKm = Math.round(evKm);
            if (evKm != null && (evKm < 0 || evKm > totalKm)) {
                toast('纯电里程应在 0 与总里程之间');
                return;
            }
        }

        const all = DB.table('odometer');
        const now = Date.now();
        all.push({
            id: uid(),
            vehicleId: v.id,
            date,
            totalKm,
            evKm: v.type === 'hybrid' ? evKm : null,
            note: '',
            createdAt: now,
            updatedAt: now,
            dirty: 1,
            deleted: 0,
        });
        DB.saveTable('odometer', all);

        byId('odoTotal').value = '';
        byId('odoEv').value = '';
        if (byId('odoFuel')) byId('odoFuel').value = '';
        renderMileageList();
        renderPerKm();
        if (typeof scheduleSync === 'function') scheduleSync(800);
        toast('已记录 ' + totalKm + ' km');
    }

    function deleteOdometer(id) {
        if (!confirm('删除这条里程记录？')) return;
        const all = DB.table('odometer');
        const o = all.find((x) => x.id === id);
        if (!o) return;
        o.deleted = 1;
        o.updatedAt = Date.now();
        o.dirty = 1;
        DB.saveTable('odometer', all);
        renderMileageList();
        renderPerKm();
        if (typeof scheduleSync === 'function') scheduleSync(800);
    }

    // ───────────────────────── 每公里花费 ─────────────────────────
    function todayStr() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    /** 两个 YYYY-MM-DD 相差的天数（b − a） */
    function daysBetween(a, b) {
        const t1 = new Date(String(a) + 'T00:00:00').getTime();
        const t2 = new Date(String(b) + 'T00:00:00').getTime();
        if (!isFinite(t1) || !isFinite(t2)) return 9999;
        return Math.round((t2 - t1) / 86400000);
    }

    function monthRange(y, m) {
        const pad = (n) => String(n).padStart(2, '0');
        const last = new Date(y, m + 1, 0).getDate();
        return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` };
    }

    /** 找离某天最近的里程读数（±maxDays 内），用于满箱法对齐加油记录 */
    function nearestReading(readings, date, maxDays) {
        let best = null;
        let bestDiff = Infinity;
        for (const r of readings) {
            const diff = Math.abs(daysBetween(r.date, date));
            if (diff <= maxDays && diff < bestDiff) {
                best = r;
                bestDiff = diff;
            }
        }
        return best;
    }

    /**
     * 满箱法分段：相邻两次「加油」之间算一段。
     * 段成本 = 后一次加油的金额（它正好补回了这段烧掉的油）；
     * 最后一段还没有下一次加油，说明油还在油箱里，不计入。
     */
    function tankSegments(vehicleId) {
        const readings = odometerOf(vehicleId);
        const fuels = DB.visibleRecords()
            .filter((r) => resolveVehicleId(r) === vehicleId && r.type === 'gas')
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createTime || 0) - (b.createTime || 0)));

        const segs = [];
        for (let i = 1; i < fuels.length; i++) {
            const a = nearestReading(readings, fuels[i - 1].date, 7);
            const b = nearestReading(readings, fuels[i].date, 7);
            if (!a || !b || a.id === b.id) continue;
            const km = Number(b.totalKm) - Number(a.totalKm);
            if (!(km > 0)) continue;
            const aEv = a.evKm != null ? Number(a.evKm) : null;
            const bEv = b.evKm != null ? Number(b.evKm) : null;
            segs.push({
                from: a.date,
                to: fuels[i].date,
                km: km,
                cost: Number(fuels[i].amount) || 0,
                evKm: aEv != null && bEv != null && bEv >= aEv ? bEv - aEv : null,
            });
        }
        return segs;
    }

    /**
     * 计算某辆车在一段日期内的里程与花费。
     * 两种口径：
     *   满箱法 tank  —— 每次加满的车：只用「完整的两桶油之间」统计，油箱里剩的油不算
     *   现金法 cash  —— 纯电车 / 定额加油的车：花费 ÷ 里程，并设里程下限避免离谱数字
     */
    function calcRange(vehicleId, from, to) {
        const v = vehicleById(vehicleId);
        const out = {
            ok: false, km: 0, total: 0, electric: 0, gas: 0,
            perKm: null, evPerKm: null, fuelPerKm: null, note: '', mode: 'cash',
            evKm: null, fuelKm: null,
            fromDate: '', fromKm: null, toDate: '', toKm: null, spendFrom: '',
        };
        if (!v) return out;

        const useTank = v.type !== 'ev' && v.fillMode !== 'fixed';

        if (useTank) {
            out.mode = 'tank';
            const segs = tankSegments(vehicleId).filter(
                (s) => (!from || s.to >= from) && (!to || s.to <= to)
            );
            const totalKm = segs.reduce((s, x) => s + x.km, 0);
            const totalCost = segs.reduce((s, x) => s + x.cost, 0);
            if (!segs.length || totalKm <= 0) {
                out.note = '满箱法需要至少两次加油，且两次附近都记过里程';
                return out;
            }
            out.ok = true;
            out.km = totalKm;
            out.total = totalCost;
            out.perKm = totalCost / totalKm;
            out.fromDate = segs[0].from;
            out.toDate = segs[segs.length - 1].to;

            if (v.type === 'hybrid') {
                const evKm = segs.reduce((s, x) => s + (x.evKm || 0), 0);
                if (evKm > 0) {
                    const er = DB.visibleRecords().filter(
                        (r) => resolveVehicleId(r) === vehicleId && r.type === 'electric' &&
                            (!from || r.date >= from) && (!to || r.date <= to)
                    );
                    const evCost = er.reduce((s, x) => s + (Number(x.amount) || 0), 0);
                    out.electric = evCost;
                    out.evPerKm = evCost / evKm;
                    out.evKm = evKm;
                    const fuelKm = totalKm - evKm;
                    out.fuelKm = fuelKm > 0 ? fuelKm : null;
                    if (fuelKm > 0) out.fuelPerKm = totalCost / fuelKm;
                }
            }
            return out;
        }

        // ── 现金口径 ──
        const readings = odometerOf(vehicleId);
        if (!readings.length) { out.note = '还没有里程记录'; return out; }

        let base = null;
        if (from) {
            const before = readings.filter((o) => o.date <= from);
            const cand = before.length ? before[before.length - 1] : null;
            if (cand && daysBetween(cand.date, from) <= 10) base = cand;
            if (!base) {
                const inRange = readings.filter((o) => o.date >= from && (!to || o.date <= to));
                base = inRange.length ? inRange[0] : null;
            }
        } else {
            base = readings[0];
        }

        const upto = to ? readings.filter((o) => o.date <= to) : readings;
        const last = upto.length ? upto[upto.length - 1] : null;

        // 起点恰好等于终点（通常是月初当天记了一次读数，而它又是最后一条）时，
        // 往前退一条更早的读数当起点，否则会自己跟自己比、算出 0 公里。
        if (from && base && last && base.date === last.date) {
            const earlier = readings.filter((o) => o.date < base.date);
            const prev = earlier.length ? earlier[earlier.length - 1] : null;
            if (prev && daysBetween(prev.date, from) <= 10) base = prev;
        }

        if (!base || !last) {
            out.note = from ? '本月缺少起点读数，记一次里程就能算' : '缺少里程数据';
            return out;
        }
        if (base.id === last.id) { out.note = '区间内只有一条里程记录，再记一次才能算'; return out; }

        const km = Number(last.totalKm) - Number(base.totalKm);
        if (!(km > 0)) { out.note = '里程没有增加，无法计算'; return out; }
        if (km < 100) {
            out.note = '行驶里程不足 100 km，参考意义不大';
            return out;
        }

        const spendFrom = from || base.date;
        const recs = DB.visibleRecords().filter(
            (r) => resolveVehicleId(r) === vehicleId && r.date >= spendFrom && (!to || r.date <= to)
        );
        recs.forEach((r) => {
            const a = Number(r.amount) || 0;
            out.total += a;
            if (r.type === 'electric') out.electric += a;
            else if (r.type === 'gas') out.gas += a;
        });

        out.ok = true;
        out.km = km;
        out.perKm = out.total / km;
        out.fromDate = base.date;
        out.fromKm = Number(base.totalKm);
        out.toDate = last.date;
        out.toKm = Number(last.totalKm);
        out.spendFrom = spendFrom;

        if (v.type === 'hybrid') {
            const bEv = base.evKm != null ? Number(base.evKm) : null;
            const lEv = last.evKm != null ? Number(last.evKm) : null;
            if (bEv != null && lEv != null) {
                const evKm = lEv - bEv;
                const fuelKm = km - evKm;
                out.evKm = evKm > 0 ? evKm : null;
                out.fuelKm = fuelKm > 0 ? fuelKm : null;
                if (evKm > 0) out.evPerKm = out.electric / evKm;
                if (fuelKm > 0) out.fuelPerKm = out.gas / fuelKm;
            }
        }
        return out;
    }

    function fmtMoney(n) {
        if (n == null || !isFinite(n)) return '—';
        return '¥' + n.toFixed(2);
    }

    /** 用电 / 用油 两个小标签：本月和累计各一组 */
    function renderSplit(suffix, v, r) {
        const box = byId('pkSplit' + suffix);
        if (!box) return;
        const show = v.type === 'hybrid' && r.ok && (r.evPerKm != null || r.fuelPerKm != null);
        box.style.display = show ? '' : 'none';
        if (!show) return;
        const ev = byId('pkEv' + suffix);
        const fuel = byId('pkFuel' + suffix);
        if (ev) ev.textContent = r.evPerKm != null ? fmtMoney(r.evPerKm) : '—';
        if (fuel) fuel.textContent = r.fuelPerKm != null ? fmtMoney(r.fuelPerKm) : '—';
    }

    function hideSplits() {
        ['pkSplitMonth', 'pkSplitTotal'].forEach((id) => {
            const el = byId(id);
            if (el) el.style.display = 'none';
        });
    }

    function renderPerKm() {
        const card = byId('perkmCard');
        if (!card) return;

        if (isAllMode()) {
            byId('pkMonth').textContent = '—';
            byId('pkTotal').textContent = '—';
            hideSplits();
            byId('pkFoot').textContent = '「全部车辆」不计算每公里，请选择具体某辆车';
            byId('mileageBtn').style.display = 'none';
            if (byId('pkRemind')) byId('pkRemind').style.display = 'none';
            return;
        }

        const v = currentVehicle();
        if (!v) {
            byId('pkMonth').textContent = '—';
            byId('pkTotal').textContent = '—';
            hideSplits();
            byId('pkFoot').textContent = '请先添加一辆车';
            byId('mileageBtn').style.display = 'none';
            if (byId('pkRemind')) byId('pkRemind').style.display = 'none';
            return;
        }

        byId('mileageBtn').style.display = '';

        const y = typeof currentYear === 'number' ? currentYear : new Date().getFullYear();
        const m = typeof currentMonth === 'number' ? currentMonth : new Date().getMonth();
        const mr = monthRange(y, m);

        const monthR = calcRange(v.id, mr.from, mr.to);
        const totalR = calcRange(v.id, '', '');
        needMonthStartDate = monthR.ok ? '' : mr.from;

        byId('pkMonth').textContent = monthR.ok ? fmtMoney(monthR.perKm) : '—';
        byId('pkTotal').textContent = totalR.ok ? fmtMoney(totalR.perKm) : '—';

        renderSplit('Month', v, monthR);
        renderSplit('Total', v, totalR);

        // 把分子 / 分母 / 读数区间全部摊开，避免"数字对不上"
        const lines = [];
        if (totalR.ok) {
            lines.push(
                '累计 ' + fmtMoney(totalR.total) + ' ÷ ' + totalR.km + ' km = ' + fmtMoney(totalR.perKm) +
                (totalR.mode === 'tank' ? '（满箱法 ' + totalR.fromDate + ' 起）' : '（现金口径）')
            );
        } else if (totalR.note) {
            lines.push('累计：' + totalR.note);
        }
        if (monthR.ok) {
            lines.push(
                '本月 ' + fmtMoney(monthR.total) + ' ÷ ' + monthR.km + ' km = ' + fmtMoney(monthR.perKm) +
                (monthR.mode === 'tank' ? '（满箱法）' : '（现金口径）')
            );
        } else if (monthR.note) {
            lines.push('本月：' + monthR.note);
        }

        // 上次记录里程：平时是一行灰色小字，太久没记才变成提示条
        const remind = byId('pkRemind');
        if (remind) {
            const list = odometerOf(v.id);
            if (!list.length) {
                remind.style.display = 'none';
            } else {
                const days = daysBetween(list[list.length - 1].date, todayStr());
                let label;
                if (days <= 0) label = '今天';
                else if (days === 1) label = '昨天';
                else label = days + ' 天前';
                remind.style.display = '';
                remind.className = 'pk-remind';
                remind.textContent = '上次记录里程 ' + label;
                if (days > 30) {
                    remind.className = 'pk-remind warn';
                    remind.textContent = '⚠️ 上次记录里程 ' + days + ' 天前，每公里数字会越来越不准';
                } else if (days > 7) {
                    remind.className = 'pk-remind due';
                    remind.textContent = '上次记录里程 ' + label + '，记得补一次读数';
                }
            }
        }

        const foot = byId('pkFoot');
        let html = lines.map(escapeHtml).join('<br />');
        if (!monthR.ok && needMonthStartDate) {
            html += '<br /><a href="#" id="pkBackfill" style="color:#2563eb;text-decoration:none;">→ 补记 ' +
                escapeHtml(needMonthStartDate.slice(0, 7)) + ' 月初读数</a>';
        }
        foot.innerHTML = html;
        foot.style.lineHeight = '1.75';
        foot.style.fontSize = '11px';
    }

    // ───────────────────────── 渲染入口 ─────────────────────────
    let promptedVehicle = false;

    // 本月缺起点读数时，点「记里程」默认带出本月 1 号
    let needMonthStartDate = '';

    function maybePromptVehicle() {
        if (promptedVehicle) return;
        if (DB.visible('vehicles').length) return;
        if (DB.visibleRecords().length) return; // 老数据走 ensureDefaultVehicle
        promptedVehicle = true;
        setTimeout(() => {
            if (document.getElementById('loginScreen').classList.contains('hidden')) openVehicleSheet();
        }, 600);
    }

    function renderVehicleUI() {
        renderVehicleBar();
        renderPerKm();
        maybePromptVehicle();
    }

    // ───────────────────────── 事件绑定 ─────────────────────────
    function bind() {
        // 「初始里程」已不参与计算（避免口径歧义），隐藏掉
        const soInput = byId('vehStartOdo');
        if (soInput) soInput.style.display = 'none';

        const addBtn = byId('vehicleAddBtn');
        if (addBtn) addBtn.addEventListener('click', () => openVehicleSheet());

        const vOverlay = byId('vehicleOverlay');
        if (vOverlay) vOverlay.addEventListener('click', closeVehicleSheet);
        const vClose = byId('vehClose');
        if (vClose) vClose.addEventListener('click', closeVehicleSheet);

        const typeToggle = byId('vehTypeToggle');
        if (typeToggle) {
            typeToggle.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-type]');
                if (btn) setVehicleType(btn.dataset.type);
            });
        }

        const fillToggle = byId('vehFillToggle');
        if (fillToggle) {
            fillToggle.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-fill]');
                if (btn) setFillMode(btn.dataset.fill);
            });
        }

        const submit = byId('vehSubmit');
        if (submit) submit.addEventListener('click', saveVehicle);
        const cancel = byId('vehCancel');
        if (cancel) cancel.addEventListener('click', () => { editingVehicleId = ''; fillVehicleForm(); });

        const mBtn = byId('mileageBtn');
        if (mBtn) mBtn.addEventListener('click', () => openMileageSheet());

        // 「补记月初读数」是独立入口，不影响主按钮默认今天
        const pkFoot = byId('pkFoot');
        if (pkFoot) {
            pkFoot.addEventListener('click', (e) => {
                const a = e.target.closest('#pkBackfill');
                if (!a) return;
                e.preventDefault();
                openMileageSheet(needMonthStartDate);
            });
        }
        const mOverlay = byId('mileageOverlay');
        if (mOverlay) mOverlay.addEventListener('click', closeMileageSheet);
        const mClose = byId('mileageClose');
        if (mClose) mClose.addEventListener('click', closeMileageSheet);
        const odoSubmit = byId('odoSubmit');
        if (odoSubmit) odoSubmit.addEventListener('click', saveOdometer);

        // 日期框右侧的日历按钮：点它调起系统日期选择器
        const odoDateBtn = byId('odoDateBtn');
        if (odoDateBtn) {
            odoDateBtn.addEventListener('click', () => {
                const input = byId('odoDate');
                if (!input) return;
                if (typeof input.showPicker === 'function') {
                    try {
                        input.showPicker();
                        return;
                    } catch (e) {
                        /* 某些浏览器要求用户手势，退回 focus */
                    }
                }
                input.focus();
                input.click();
            });
        }

        const autoToggle = byId('odoAutoToggle');
        if (autoToggle) {
            autoToggle.addEventListener('change', () => {
                setAutoOdo(!!autoToggle.checked);
                toast(
                    autoToggle.checked ? '已开启：记账后自动提醒记里程' : '已关闭：记账后不再自动弹出',
                    2200
                );
            });
        }

        ['odoTotal', 'odoEv', 'odoFuel'].forEach((id) => {
            const el = byId(id);
            if (el) el.addEventListener('input', updateOdoPreview);
        });

        // 打开记账面板时，按当前车型限制可选的能源类型
        const fab = byId('fabAdd');
        if (fab) fab.addEventListener('click', () => setTimeout(applyTypeConstraints, 50));

        const conflictClose = byId('conflictClose');
        if (conflictClose) conflictClose.addEventListener('click', closeConflictSheet);
        const conflictOverlay = byId('conflictOverlay');
        if (conflictOverlay) conflictOverlay.addEventListener('click', closeConflictSheet);
        const acctConflictRow = byId('acctConflictRow');
        if (acctConflictRow) {
            acctConflictRow.addEventListener('click', () => {
                if (typeof window.__closeAccount === 'function') window.__closeAccount();
                openConflictSheet();
            });
        }
    }

    // ───────────────────────── 工具 ─────────────────────────
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();

    // 暴露给主脚本 / 同步模块
    window.Vehicles = {
        TYPES,
        vehicles,
        vehicleById,
        currentVehicle,
        currentVehicleId: () => currentVehicleId,
        isAllMode,
        resolveVehicleId,
        ensureDefaultVehicle,
        setCurrentVehicle,
        renderVehicleUI,
        renderVehicleBar,
        renderPerKm,
        applyTypeConstraints,
        allowedKinds,
        candidatesFor,
        canRecordKind,
        typeLabel,
        conflicts,
        refreshConflictUI,
        openVehicleSheet,
        openMileageSheet,
        afterAddRecord,
        calcRange,
        monthRange,
        escapeHtml,
        setCurrentVehicleSilent(id) { currentVehicleId = id; },
    };
})();
