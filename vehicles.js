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
    function vehicles() {
        return DB.visible('vehicles').slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
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
        return list.length ? list[0].id : '';
    }

    /** 首次进入且一辆车都没有时，建一辆默认车（id 与服务端迁移脚本保持一致，不会重复） */
    function ensureDefaultVehicle() {
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
    }

    function closeVehicleSheet() {
        byId('vehicleSheet').classList.remove('active');
        byId('vehicleOverlay').classList.remove('active');
        editingVehicleId = '';
    }

    function renderVehicleList() {
        const box = byId('vehicleList');
        const list = vehicles();
        if (!list.length) {
            box.innerHTML = `<div class="empty-msg">还没有车辆，先在下面添加一辆</div>`;
            return;
        }
        box.innerHTML = list
            .map((v) => {
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
                        <button data-act="edit" data-id="${v.id}">编辑</button>
                        <button data-act="del" data-id="${v.id}" class="danger">删除</button>
                    </div>
                </div>`;
            })
            .join('');

        box.querySelectorAll('button[data-act]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.dataset.act === 'edit') openVehicleSheet(btn.dataset.id);
                else deleteVehicle(btn.dataset.id);
            });
        });
    }

    function fillVehicleForm() {
        const v = editingVehicleId ? vehicleById(editingVehicleId) : null;
        byId('vehicleFormTitle').textContent = v ? '编辑车辆' : '添加车辆';
        byId('vehName').value = v ? v.name : '';
        byId('vehStartOdo').value = v && v.startOdometer ? v.startOdometer : '';
        setVehicleType(v ? v.type : 'hybrid');
        byId('vehSubmit').textContent = v ? '保存修改' : '添加';
        byId('vehCancel').style.display = v ? '' : 'none';
    }

    function setVehicleType(type) {
        byId('vehicleForm').dataset.type = type;
        document.querySelectorAll('#vehTypeToggle button').forEach((b) => {
            b.classList.toggle('active', b.dataset.type === type);
        });
    }

    function saveVehicle() {
        const name = byId('vehName').value.trim();
        const type = byId('vehicleForm').dataset.type || 'hybrid';
        const start = Number(byId('vehStartOdo').value) || 0;
        if (!name) { toast('请填写车辆名称'); return; }

        const all = DB.table('vehicles');
        const now = Date.now();
        const existing = editingVehicleId ? all.find((x) => x.id === editingVehicleId) : null;

        if (existing) {
            existing.name = name;
            existing.type = type;
            existing.startOdometer = start;
            existing.updatedAt = now;
            existing.dirty = 1;
            toast('已保存');
        } else {
            const id = uid();
            all.push({
                id, name, type, note: '',
                startOdometer: start,
                createdAt: now, updatedAt: now, dirty: 1, deleted: 0,
            });
            currentVehicleId = id;
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

        if (currentVehicleId === id) currentVehicleId = '';
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

    function openMileageSheet() {
        const v = currentVehicle();
        if (!v) { toast('先选择一辆车'); return; }
        byId('odoDate').value = typeof getTodayStr === 'function' ? getTodayStr() : new Date().toISOString().slice(0, 10);
        byId('odoTotal').value = '';
        byId('odoEv').value = '';
        byId('odoEvField').style.display = v.type === 'hybrid' ? '' : 'none';
        byId('odoEvHint').style.display = v.type === 'hybrid' ? '' : 'none';
        renderMileageList();
        byId('mileageSheet').classList.add('active');
        byId('mileageOverlay').classList.add('active');
        setTimeout(() => byId('odoTotal').focus(), 260);
    }

    function closeMileageSheet() {
        byId('mileageSheet').classList.remove('active');
        byId('mileageOverlay').classList.remove('active');
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
                return `<div class="orow">
                    <div>
                        <div class="orow-km">${o.totalKm} km</div>
                        <div class="orow-sub">${o.date}${ev}</div>
                    </div>
                    <button class="orow-del" data-id="${o.id}" title="删除">✕</button>
                </div>`;
            })
            .join('');
        box.querySelectorAll('.orow-del').forEach((btn) => {
            btn.addEventListener('click', () => deleteOdometer(btn.dataset.id));
        });
    }

    function saveOdometer() {
        const v = currentVehicle();
        if (!v) return;
        const date = byId('odoDate').value;
        const totalKm = Number(byId('odoTotal').value);
        const evRaw = byId('odoEv').value;
        const evKm = evRaw === '' ? null : Number(evRaw);

        if (!date) { toast('请选择日期'); return; }
        if (!Number.isFinite(totalKm) || totalKm <= 0) { toast('请填写有效的总里程'); return; }
        if (v.type === 'hybrid' && evKm != null && evKm > totalKm) { toast('纯电里程不能大于总里程'); return; }

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
    function monthRange(y, m) {
        const pad = (n) => String(n).padStart(2, '0');
        const last = new Date(y, m + 1, 0).getDate();
        return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` };
    }

    /**
     * 计算某辆车在一段日期内的里程与花费
     * @returns {object} { ok, km, total, electric, gas, perKm, evPerKm, fuelPerKm, note }
     */
    function calcRange(vehicleId, from, to) {
        const v = vehicleById(vehicleId);
        const out = { ok: false, km: 0, total: 0, electric: 0, gas: 0, perKm: null, evPerKm: null, fuelPerKm: null, note: '' };
        if (!v) return out;

        const recs = DB.visibleRecords().filter(
            (r) => resolveVehicleId(r) === vehicleId && (!from || r.date >= from) && (!to || r.date <= to)
        );
        recs.forEach((r) => {
            const a = Number(r.amount) || 0;
            out.total += a;
            if (r.type === 'electric') out.electric += a;
            else if (r.type === 'gas') out.gas += a;
        });

        const readings = odometerOf(vehicleId);
        const inOrBefore = (d) => readings.filter((o) => o.date <= d);

        // 区间起点读数：区间内/之前最后一个
        const beforeList = inOrBefore(from || '0000-00-00');
        const lastList = inOrBefore(to || '9999-99-99');

        let base = beforeList.length ? beforeList[beforeList.length - 1] : null;
        let baseKm = null;
        let baseEv = null;
        let baseFromStartOdo = false;

        if (!base && v.startOdometer > 0) {
            baseKm = Number(v.startOdometer);
            baseFromStartOdo = true;
        } else if (base) {
            baseKm = Number(base.totalKm);
            baseEv = base.evKm != null ? Number(base.evKm) : null;
        }

        const last = lastList.length ? lastList[lastList.length - 1] : null;
        if (last && baseKm == null) {
            // 没有任何基线：用区间内第一条读数当基线（会略微高估每公里）
            const firstInRange = readings.find((o) => (!from || o.date >= from) && (!to || o.date <= to));
            if (firstInRange && firstInRange.id === last.id) {
                out.note = '只有一条里程记录，无法计算';
                return out;
            }
            if (firstInRange) {
                baseKm = Number(firstInRange.totalKm);
                baseEv = firstInRange.evKm != null ? Number(firstInRange.evKm) : null;
                out.note = '里程起点取自区间内第一条记录，结果偏保守';
            }
        }

        if (!last || baseKm == null) {
            out.note = last ? '' : '还没有里程记录';
            return out;
        }

        const km = Number(last.totalKm) - baseKm;
        if (!(km > 0)) {
            out.note = baseFromStartOdo ? '请记录一次当前里程' : '里程没有增加，无法计算';
            return out;
        }

        out.km = km;
        out.ok = true;
        out.perKm = out.total / km;

        if (v.type === 'hybrid') {
            const lastEv = last.evKm != null ? Number(last.evKm) : null;
            if (lastEv != null && baseEv != null) {
                const evKm = lastEv - baseEv;
                const fuelKm = km - evKm;
                if (evKm > 0) out.evPerKm = out.electric / evKm;
                if (fuelKm > 0) out.fuelPerKm = out.gas / fuelKm;
            } else {
                out.note = out.note || '混动车型填了纯电里程才能分用电/用油';
            }
        }
        return out;
    }

    function fmtMoney(n) {
        if (n == null || !isFinite(n)) return '—';
        return '¥' + n.toFixed(2);
    }

    function renderPerKm() {
        const card = byId('perkmCard');
        if (!card) return;

        if (isAllMode()) {
            byId('pkMonth').textContent = '—';
            byId('pkTotal').textContent = '—';
            byId('pkSplit').style.display = 'none';
            byId('pkFoot').textContent = '「全部车辆」不计算每公里，请选择具体某辆车';
            byId('mileageBtn').style.display = 'none';
            return;
        }

        const v = currentVehicle();
        if (!v) {
            byId('pkMonth').textContent = '—';
            byId('pkTotal').textContent = '—';
            byId('pkSplit').style.display = 'none';
            byId('pkFoot').textContent = '请先添加一辆车';
            byId('mileageBtn').style.display = 'none';
            return;
        }

        byId('mileageBtn').style.display = '';

        const y = typeof currentYear === 'number' ? currentYear : new Date().getFullYear();
        const m = typeof currentMonth === 'number' ? currentMonth : new Date().getMonth();
        const mr = monthRange(y, m);

        const month = calcRange(v.id, mr.from, mr.to);
        const total = calcRange(v.id, '', '');

        byId('pkMonth').textContent = month.ok ? fmtMoney(month.perKm) : '—';
        byId('pkTotal').textContent = total.ok ? fmtMoney(total.perKm) : '—';

        const split = byId('pkSplit');
        if (v.type === 'hybrid' && month.ok && (month.evPerKm != null || month.fuelPerKm != null)) {
            split.style.display = '';
            byId('pkEv').textContent = month.evPerKm != null ? fmtMoney(month.evPerKm) : '—';
            byId('pkFuel').textContent = month.fuelPerKm != null ? fmtMoney(month.fuelPerKm) : '—';
        } else {
            split.style.display = 'none';
        }

        const readings = odometerOf(v.id);
        const lastOdo = readings.length ? readings[readings.length - 1] : null;
        const foot = byId('pkFoot');
        if (!lastOdo) {
            foot.textContent = '还没有里程记录，点右侧「记里程」开始';
        } else {
            const kmText = month.ok ? `本月跑了 ${month.km} km` : (month.note || '本月里程不足');
            foot.textContent = `上次读数 ${lastOdo.totalKm} km（${lastOdo.date}）· ${kmText}`;
        }
    }

    // ───────────────────────── 渲染入口 ─────────────────────────
    let promptedVehicle = false;

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

        const submit = byId('vehSubmit');
        if (submit) submit.addEventListener('click', saveVehicle);
        const cancel = byId('vehCancel');
        if (cancel) cancel.addEventListener('click', () => { editingVehicleId = ''; fillVehicleForm(); });

        const mBtn = byId('mileageBtn');
        if (mBtn) mBtn.addEventListener('click', openMileageSheet);
        const mOverlay = byId('mileageOverlay');
        if (mOverlay) mOverlay.addEventListener('click', closeMileageSheet);
        const mClose = byId('mileageClose');
        if (mClose) mClose.addEventListener('click', closeMileageSheet);
        const odoSubmit = byId('odoSubmit');
        if (odoSubmit) odoSubmit.addEventListener('click', saveOdometer);

        // 打开记账面板时，按当前车型限制可选的能源类型
        const fab = byId('fabAdd');
        if (fab) fab.addEventListener('click', () => setTimeout(applyTypeConstraints, 50));
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
        openVehicleSheet,
        calcRange,
        monthRange,
        escapeHtml,
        setCurrentVehicleSilent(id) { currentVehicleId = id; },
    };
})();
