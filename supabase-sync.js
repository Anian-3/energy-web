/* ================================================================
   小紫油电记录 · Supabase 免服务器版
   数据直接存到你自己的 Supabase 项目（免费、不要信用卡），
   网页挂在 GitHub Pages 上，没有任何自己的后端要维护。

   依赖主脚本暴露的：DB / currentUser / records / loadRecords
                    / renderAll / init / showToast
   ================================================================ */
(function () {
    'use strict';

    const URL_KEY = 'sb_url';
    const KEY_KEY = 'sb_key';
    const SESSION_KEY = 'sb_session';

    const CFG = { url: '', key: '' };
    const SESSION = { access: '', refresh: '', expiresAt: 0, user: null };

    let syncing = false;
    let syncTimer = 0;
    let booted = false;
    let loginMode = 'login';
    let lastSyncAt = 0;
    let lastVisibleSync = 0;
    let status = { kind: 'offline', text: '未连接' };

    const byId = (id) => document.getElementById(id);
    const toast = (msg, ms) => { if (typeof showToast === 'function') showToast(msg, ms || 1800); };

    // ───────────────────────── 配置 ─────────────────────────
    function loadCfg() {
        CFG.url = (localStorage.getItem(URL_KEY) || '').trim().replace(/\/+$/, '');
        CFG.key = (localStorage.getItem(KEY_KEY) || '').trim();
    }

    function saveCfg(url, key) {
        CFG.url = String(url || '').trim().replace(/\/+$/, '');
        CFG.key = String(key || '').trim();
        localStorage.setItem(URL_KEY, CFG.url);
        localStorage.setItem(KEY_KEY, CFG.key);
    }

    const hasCfg = () => !!(CFG.url && CFG.key);

    // ───────────────────────── 请求 ─────────────────────────
    async function rawFetch(path, opts) {
        const res = await fetch(CFG.url + path, opts);
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
        return { res, data };
    }

    /** 调用 GoTrue / PostgREST；自动处理 401 刷新令牌 */
    async function sb(path, { method = 'GET', body, prefer, auth = true, base = '' } = {}) {
        const headers = {
            apikey: CFG.key,
            'Content-Type': 'application/json',
        };
        if (base) headers.Authorization = 'Bearer ' + base;
        else if (auth && SESSION.access) headers.Authorization = 'Bearer ' + SESSION.access;
        if (prefer) headers.Prefer = prefer;

        let { res, data } = await rawFetch(path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        if (res.status === 401 && auth && SESSION.refresh && !base) {
            const ok = await refreshToken();
            if (ok) {
                headers.Authorization = 'Bearer ' + SESSION.access;
                ({ res, data } = await rawFetch(path, {
                    method,
                    headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                }));
            }
        }

        if (!res.ok) {
            const msg = (data && (data.msg || data.message || data.error_description || data.error || data.hint)) ||
                ('请求失败（HTTP ' + res.status + '）');
            const err = new Error(String(msg));
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    // ───────────────────────── 会话 ─────────────────────────
    function applySession(data) {
        SESSION.access = data.access_token || '';
        SESSION.refresh = data.refresh_token || SESSION.refresh;
        SESSION.expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
        if (data.user) {
            SESSION.user = {
                id: data.user.id,
                username: usernameFromEmail(data.user.email || ''),
            };
        }
        localStorage.setItem(SESSION_KEY, JSON.stringify({
            access: SESSION.access,
            refresh: SESSION.refresh,
            expiresAt: SESSION.expiresAt,
            user: SESSION.user,
        }));
    }

    function restoreSession() {
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (!s || !s.refresh) return;
            SESSION.access = s.access || '';
            SESSION.refresh = s.refresh;
            SESSION.expiresAt = Number(s.expiresAt) || 0;
            SESSION.user = s.user || null;
        } catch (e) {
            /* 忽略损坏的会话 */
        }
    }

    function clearSession() {
        SESSION.access = '';
        SESSION.refresh = '';
        SESSION.expiresAt = 0;
        SESSION.user = null;
        localStorage.removeItem(SESSION_KEY);
    }

    async function refreshToken() {
        if (!SESSION.refresh) return false;
        try {
            const data = await sb('/auth/v1/token?grant_type=refresh_token', {
                method: 'POST',
                body: { refresh_token: SESSION.refresh },
                auth: false,
            });
            applySession(data);
            return true;
        } catch (e) {
            clearSession();
            return false;
        }
    }

    async function ensureToken() {
        if (!SESSION.access) return false;
        if (SESSION.expiresAt - 60000 > Date.now()) return true;
        return await refreshToken();
    }

    // 账号映射：含 @ 当真实邮箱用；否则映射成 <名字>@example.com
    function emailFromUsername(name) {
        // 账号名只允许 ASCII；这里再兜一次底，防止历史数据里带中文导致奇怪的邮箱
        const v = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._@-]/g, '');
        if (!v) return '';
        return v.includes('@') ? v : v + '@example.com';
    }

    function usernameFromEmail(email) {
        const v = String(email || '');
        return v.endsWith('@example.com') ? v.slice(0, -'@example.com'.length) : v;
    }

    // ───────────────────────── 状态显示 ─────────────────────────
    function setStatus(kind, text) {
        status = { kind, text };
        const dot = byId('syncDot');
        if (dot) dot.className = 'sync-dot ' + kind;
        const st = byId('acctStatus');
        if (st) st.textContent = text;
    }

    function timeAgo(ts) {
        if (!ts) return '从未';
        const d = Date.now() - ts;
        if (d < 60000) return '刚刚';
        if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
        if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
        return Math.floor(d / 86400000) + ' 天前';
    }

    function updateCount() {
        const el = byId('acctCount');
        if (el) el.textContent = (typeof records !== 'undefined' && records ? records.length : 0) + ' 条';
    }

    function renderAccountPanel() {
        if (!SESSION.user) {
            const name = byId('acctName');
            if (name) name.textContent = '未登录';
            return;
        }
        const u = SESSION.user;
        byId('acctName').textContent = u.username;
        byId('acctAvatar').textContent = String(u.username || 'U').slice(0, 1).toUpperCase();
        byId('acctMeta').textContent = status.text;
        byId('acctLast').textContent = timeAgo(lastSyncAt);
        updateCount();
    }

    // ───────────────────────── 同步 ─────────────────────────
    const TABLES = [
        {
            name: 'vehicles',
            path: '/rest/v1/vehicles',
            cols: 'id,name,type,note,start_odometer,fill_mode,compare_consumption,fuel_price,created_at,client_ts,deleted',
            toRow(v) {
                return {
                    id: v.id,
                    name: v.name,
                    type: v.type,
                    note: v.note || '',
                    start_odometer: Math.round(Number(v.startOdometer) || 0),
                    fill_mode: v.fillMode === 'fixed' ? 'fixed' : 'full',
                    compare_consumption: Number(v.compareConsumption) || 0,
                    fuel_price: Number(v.fuelPrice) || 0,
                    created_at: Number(v.createdAt) || 0,
                    client_ts: Number(v.updatedAt) || 0,
                    deleted: !!v.deleted,
                };
            },
            fromRow(o) {
                return {
                    id: o.id,
                    name: o.name,
                    type: o.type,
                    note: o.note || '',
                    startOdometer: Number(o.start_odometer) || 0,
                    fillMode: o.fill_mode === 'fixed' ? 'fixed' : 'full',
                    createdAt: Number(o.created_at) || 0,
                    updatedAt: Number(o.client_ts) || 0,
                    deleted: o.deleted ? 1 : 0,
                };
            },
        },
        {
            name: 'records',
            path: '/rest/v1/records',
            cols: 'id,date,type,amount,note,use_points,create_time,client_ts,deleted,vehicle_id,charge_site',
            toRow(r) {
                return {
                    id: r.id,
                    date: r.date,
                    type: r.type,
                    amount: Number(r.amount) || 0,
                    note: r.note || '',
                    use_points: !!r.usePoints,
                    create_time: Number(r.createTime) || 0,
                    client_ts: Number(r.updatedAt) || 0,
                    deleted: !!r.deleted,
                    vehicle_id: r.vehicleId || null,
                    charge_site: r.chargeSite || '',
                };
            },
            fromRow(o) {
                return {
                    id: o.id,
                    date: o.date,
                    type: o.type,
                    amount: Number(o.amount) || 0,
                    note: o.note || '',
                    usePoints: !!o.use_points,
                    createTime: Number(o.create_time) || 0,
                    updatedAt: Number(o.client_ts) || 0,
                    deleted: o.deleted ? 1 : 0,
                    vehicleId: o.vehicle_id || '',
                };
            },
        },
        {
            name: 'odometer',
            path: '/rest/v1/odometer',
            cols: 'id,vehicle_id,date,total_km,ev_km,note,created_at,client_ts,deleted',
            toRow(o) {
                // 里程列在数据库里是 bigint，必须取整，否则 Postgres 会报
                // invalid input syntax for type bigint
                const ev = o.evKm === null || o.evKm === undefined || o.evKm === '' ? null : Math.round(Number(o.evKm));
                return {
                    id: o.id,
                    vehicle_id: o.vehicleId,
                    date: o.date,
                    total_km: Math.round(Number(o.totalKm) || 0),
                    ev_km: ev,
                    note: o.note || '',
                    created_at: Math.round(Number(o.createdAt) || 0),
                    client_ts: Math.round(Number(o.updatedAt) || 0),
                    deleted: !!o.deleted,
                };
            },
            fromRow(o) {
                return {
                    id: o.id,
                    vehicleId: o.vehicle_id,
                    date: o.date,
                    totalKm: Number(o.total_km) || 0,
                    evKm: o.ev_km === null || o.ev_km === undefined ? null : Number(o.ev_km),
                    note: o.note || '',
                    createdAt: Number(o.created_at) || 0,
                    updatedAt: Number(o.client_ts) || 0,
                    deleted: o.deleted ? 1 : 0,
                };
            },
        },
    ];

    function scheduleSync(delay) {
        if (!SESSION.access) return;
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => { syncNow(); }, delay === undefined ? 1200 : delay);
    }

    function sameRow(local, s) {
        return Object.keys(s).every((k) => {
            const b = s[k];
            const a = local[k];
            if (typeof b === 'boolean') return !!a === b;
            if (typeof b === 'number') return Number(a) === b;
            if (b === null) return a === null || a === undefined || a === '';
            return String(a === null || a === undefined ? '' : a) === String(b);
        });
    }

    function applyRemote(table, rows) {
        if (!rows || !rows.length) return false;
        const all = DB.table(table.name);
        const map = new Map(all.map((r) => [r.id, r]));
        let changed = false;

        for (const o of rows) {
            const s = table.fromRow(o);
            const local = map.get(s.id);
            // 本地有未上传且更新的改动 → 保留本地
            if (local && local.dirty && (local.updatedAt || 0) > (s.updatedAt || 0)) continue;
            if (local && !local.dirty && sameRow(local, s)) continue;
            map.set(s.id, Object.assign({}, s, { dirty: 0 }));
            changed = true;
        }

        if (changed) DB.saveTable(table.name, Array.from(map.values()));
        return changed;
    }

    async function syncNow(opts) {
        if (!SESSION.access || syncing || !hasCfg()) return;
        if (!navigator.onLine) {
            setStatus('offline', '离线，联网后自动同步');
            return;
        }

        syncing = true;
        setStatus('syncing', '同步中…');
        try {
            await ensureToken();

            // 1) 推送所有待上传的改动（三张表）
            for (const table of TABLES) {
                const dirty = DB.table(table.name).filter((r) => r.dirty);
                if (!dirty.length) continue;
                const rows = dirty.map(table.toRow);
                for (let k = 0; k < rows.length; k += 200) {
                    await sb(table.path + '?on_conflict=user_id,id', {
                        method: 'POST',
                        body: rows.slice(k, k + 200),
                        prefer: 'resolution=merge-duplicates,return=minimal',
                    });
                }
                const sent = new Map(dirty.map((r) => [r.id, r.updatedAt]));
                DB.markClean(table.name, sent);
            }

            // 2) 拉取三张表并合并
            let changed = false;
            for (const table of TABLES) {
                const rows = await sb(table.path + '?select=' + encodeURIComponent(table.cols) + '&limit=20000');
                if (applyRemote(table, rows || [])) changed = true;
            }

            if (window.Vehicles) {
                window.Vehicles.ensureDefaultVehicle();
                window.Vehicles.renderVehicleUI();
            }
            records = loadRecords();
            if (changed && typeof renderAll === 'function') renderAll();

            lastSyncAt = Date.now();
            localStorage.setItem('sb_last_sync', String(lastSyncAt));
            setStatus('ok', '已同步');
            renderAccountPanel();
        } catch (e) {
            if (e.status === 401) {
                setStatus('error', '登录已过期');
                if (opts && opts.manual) toast('登录已过期，请重新登录');
            } else if (!navigator.onLine) {
                setStatus('offline', '离线，联网后自动同步');
            } else {
                setStatus('error', '同步失败');
                if (opts && opts.manual) toast('同步失败：' + (e.message || '网络异常'), 2600);
                console.warn('[sync]', e);
            }
        } finally {
            syncing = false;
            renderAccountPanel();
        }
    }

    // ───────────────────────── 旧数据迁移 ─────────────────────────
    function migrateGuestData() {
        let guest = [];
        try {
            const raw = localStorage.getItem('hybrid_energy_records');
            if (raw) guest = JSON.parse(raw) || [];
        } catch (e) { return; }
        if (!Array.isArray(guest) || !guest.length) return;

        const msg = '检测到本机有 ' + guest.length + ' 条旧的本地记录，是否一并上传到当前账号？';
        if (!confirm(msg)) return;

        const all = DB.table('records');
        const now = Date.now();
        let added = 0;
        guest.forEach((r, i) => {
            if (!r || !r.id || !r.date || !r.type) return;
            if (all.some((x) => x.id === r.id)) return;
            all.push({
                id: r.id,
                date: r.date,
                type: r.type,
                vehicleId: '',
                amount: Number(r.amount) || 0,
                note: r.note || '',
                usePoints: !!r.usePoints,
                createTime: r.createTime || now,
                updatedAt: now + i,
                dirty: 1,
                deleted: 0,
            });
            added++;
        });
        if (!added) return;

        DB.saveTable('records', all);
        records = loadRecords();
        if (typeof renderAll === 'function') renderAll();
        try { localStorage.setItem('hybrid_energy_records_backup', JSON.stringify(guest)); } catch (e) {}
        localStorage.removeItem('hybrid_energy_records');
        toast('已导入 ' + added + ' 条旧记录，正在上传…', 2200);
        scheduleSync(0);
    }

    // ───────────────────────── 服务器设置 ─────────────────────────
    function showSetup() {
        byId('setupScreen').classList.remove('hidden');
        byId('loginScreen').classList.add('hidden');
        byId('setupUrl').value = CFG.url || '';
        byId('setupKey').value = CFG.key || '';
    }

    function hideSetup() {
        byId('setupScreen').classList.add('hidden');
    }

    async function saveSetup() {
        const url = byId('setupUrl').value.trim().replace(/\/+$/, '');
        const key = byId('setupKey').value.trim();
        const errEl = byId('setupError');
        const btn = byId('setupSave');

        errEl.textContent = '';
        if (!/^https?:\/\/[^\s/]+$/i.test(url)) {
            errEl.textContent = '地址应形如 https://xxxxxxxx.supabase.co（只填到 .co，不要带 /rest 之类）';
            return;
        }
        if (key.length < 40) {
            errEl.textContent = 'Key 看起来不完整（anon public key 是一长串）';
            return;
        }

        btn.disabled = true;
        btn.textContent = '连接中…';
        try {
            // ① 只校验「地址 + Key 是否有效」：/auth/v1/settings 是公开端点，不涉及表权限
            const settingsRes = await fetch(url + '/auth/v1/settings', {
                headers: { apikey: key },
            });
            if (settingsRes.status === 401 || settingsRes.status === 403) {
                throw new Error('Key 无效。要复制 anon public 那一条，不是 service_role');
            }
            if (!settingsRes.ok) throw new Error('连接失败（HTTP ' + settingsRes.status + '）');
            const settings = await settingsRes.json().catch(() => ({}));

            // ② 再看表建没建。注意：表已经开了行级权限时，匿名读会被拒绝（401/403），
            //    这是正常且安全的表现，不能当成错误；只有 404 才说明表不存在。
            const tableRes = await fetch(url + '/rest/v1/records?select=id&limit=1', {
                headers: { apikey: key },
            });
            if (tableRes.status === 404) {
                throw new Error('连上了，但没找到 records 表 —— schema.sql 还没执行或没跑成功');
            }

            saveCfg(url, key);
            hideSetup();
            showLogin('login');
            if (settings && settings.mailer_autoconfirm === false) {
                toast('已连接。注意：此项目开启了邮箱确认，注册后需点邮件里的链接', 4200);
            } else {
                toast('服务器已连接');
            }
        } catch (e) {
            errEl.textContent = /Failed to fetch|NetworkError|load failed/i.test(e.message)
                ? '连不上：检查地址是否填错、或网络是否被挡'
                : (e.message || '连接失败');
        } finally {
            btn.disabled = false;
            btn.textContent = '连接并保存';
        }
    }

    // ───────────────────────── 登录界面 ─────────────────────────
    function setMode(mode) {
        loginMode = mode;
        document.querySelectorAll('#authTabs button').forEach((b) => {
            b.classList.toggle('active', b.dataset.mode === mode);
        });
        byId('authPass2Field').style.display = mode === 'register' ? '' : 'none';
        byId('authSubmit').textContent = mode === 'register' ? '注 册' : '登 录';
        byId('authPass').setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
        byId('authError').textContent = '';
    }

    function showLogin(mode) {
        byId('loginScreen').classList.remove('hidden');
        setMode(mode || 'login');
        setTimeout(() => { const u = byId('authUser'); if (u && !u.value) u.focus(); }, 240);
    }

    function hideLogin() {
        byId('loginScreen').classList.add('hidden');
    }

    function authError(msg) {
        byId('authError').textContent = msg || '';
    }

    async function doAuth() {
        const username = byId('authUser').value.trim();
        const password = byId('authPass').value;
        const btn = byId('authSubmit');

        if (!username || !password) { authError('请输入账号和密码'); return; }
        if (!/^[A-Za-z0-9._-]{3,24}$/.test(username)) {
            authError('账号只能用字母、数字、下划线、点或横线，3-24 位（不能用中文）');
            return;
        }
        if (loginMode === 'register') {
            if (password.length < 6) { authError('密码至少 6 位'); return; }
            if (password !== byId('authPass2').value) { authError('两次输入的密码不一致'); return; }
        }

        authError('');
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = loginMode === 'register' ? '注册中…' : '登录中…';

        try {
            const email = emailFromUsername(username);
            let data;
            if (loginMode === 'register') {
                data = await sb('/auth/v1/signup', {
                    method: 'POST',
                    body: { email, password },
                    auth: false,
                });
                if (!data || !data.access_token) {
                    authError('注册成功，但项目开启了「邮箱确认」。请到 Supabase 关掉 Confirm email 后重新登录，或改用真实邮箱注册。');
                    btn.disabled = false;
                    btn.textContent = original;
                    return;
                }
            } else {
                data = await sb('/auth/v1/token?grant_type=password', {
                    method: 'POST',
                    body: { email, password },
                    auth: false,
                });
            }
            applySession(data);
            byId('authPass').value = '';
            byId('authPass2').value = '';
            enterApp(SESSION.user);
            toast((loginMode === 'register' ? '注册成功，' : '欢迎回来，') + SESSION.user.username);
        } catch (e) {
            const m = String(e.message || '');
            if (/already registered|already exists|User already/i.test(m)) authError('这个账号已存在，直接「登录」即可');
            else if (/Invalid login credentials/i.test(m)) authError('账号或密码不正确');
            else if (/Password should be at least/i.test(m)) authError('密码太短（Supabase 要求至少 6 位）');
            else authError(m || '操作失败，请稍后再试');
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    }

    // ───────────────────────── 账号面板 ─────────────────────────
    function openAccount() {
        renderAccountPanel();
        byId('acctPanel').classList.add('show');
        byId('acctMask').classList.add('show');
        if (window.__ovEnter) window.__ovEnter();
    }

    function closeAccount() {
        const wasOpen = byId('acctPanel').classList.contains('show');
        byId('acctPanel').classList.remove('show');
        byId('acctMask').classList.remove('show');
        byId('acctPwdBox').classList.remove('show');
        byId('pwdError').textContent = '';
        if (wasOpen && window.__ovLeave) window.__ovLeave();
    }

    async function savePassword() {
        const newPass = byId('pwdNew').value;
        const errEl = byId('pwdError');
        if (!newPass) { errEl.textContent = '请填写新密码'; return; }
        if (newPass.length < 6) { errEl.textContent = '新密码至少 6 位'; return; }
        try {
            await ensureToken();
            await sb('/auth/v1/user', { method: 'PUT', body: { password: newPass } });
            byId('pwdOld').value = '';
            byId('pwdNew').value = '';
            byId('acctPwdBox').classList.remove('show');
            errEl.textContent = '';
            toast('密码已修改');
        } catch (e) {
            errEl.textContent = e.message || '修改失败';
        }
    }

    async function logout() {
        if (!confirm('退出登录后本机将看不到云端数据（本地缓存会保留），确定退出？')) return;
        try {
            await sb('/auth/v1/logout', { method: 'POST' });
        } catch (e) { /* 令牌可能已过期，忽略 */ }
        clearSession();
        location.reload();
    }

    function wireAccountUI() {
        byId('acctBtn').addEventListener('click', openAccount);

        // 使用说明的开关统一在 index.html 内联脚本里绑定（window.__openGuide）

        // 页脚 / 登录页的版本号 → 更新日志，统一在 index.html 的内联脚本里绑定
        // （避免这个文件没更新时入口失效）
        byId('acctMask').addEventListener('click', closeAccount);
        byId('acctSync').addEventListener('click', () => { toast('正在同步…', 900); syncNow({ manual: true }); });
        byId('acctPwdBtn').addEventListener('click', () => {
            byId('acctPwdBox').classList.toggle('show');
        });
        byId('pwdSave').addEventListener('click', savePassword);
        byId('acctLogout').addEventListener('click', logout);
        byId('acctSetup').addEventListener('click', () => { closeAccount(); showSetup(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const g = byId('guideScreen');
                if (g && !g.classList.contains('hidden')) {
                    g.classList.add('hidden');
                    return;
                }
                const c = byId('changelogScreen');
                if (c && !c.classList.contains('hidden')) {
                    c.classList.add('hidden');
                    return;
                }
                closeAccount();
            }
        });
    }

    function wireLoginUI() {
        byId('authTabs').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-mode]');
            if (btn) setMode(btn.dataset.mode);
        });
        byId('authSubmit').addEventListener('click', doAuth);

        // 账号输入框：只允许 ASCII，中文/符号会被实时过滤掉
        const userEl = byId('authUser');
        if (userEl) {
            let composing = false;
            const sanitize = () => {
                const raw = userEl.value;
                const clean = raw.replace(/[^A-Za-z0-9._-]/g, '');
                if (clean !== raw) {
                    userEl.value = clean;
                    try { userEl.setSelectionRange(clean.length, clean.length); } catch (err) { /* 忽略 */ }
                    authError('账号不能用中文或符号，只能用字母、数字、下划线');
                } else if ((byId('authError').textContent || '').indexOf('账号不能用') === 0) {
                    authError('');
                }
            };
            userEl.addEventListener('compositionstart', () => { composing = true; });
            userEl.addEventListener('compositionend', () => { composing = false; sanitize(); });
            userEl.addEventListener('input', (e) => {
                if (composing || e.isComposing) return;
                sanitize();
            });
            userEl.addEventListener('paste', () => setTimeout(sanitize, 0));
        }
        ['authUser', 'authPass', 'authPass2'].forEach((id) => {
            byId(id).addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doAuth(); }
            });
        });
        byId('setupSave').addEventListener('click', saveSetup);
        byId('setupHelp').addEventListener('click', (e) => {
            e.preventDefault();
            if (typeof window.__openGuide === 'function') {
                window.__openGuide('help');
            } else {
                alert('请打开页面使用说明，「一、开始前你需要准备什么」和「二、第一次使用：连接并登录」里有详细步骤。');
            }
        });
    }

    // ───────────────────────── 启动 ─────────────────────────
    function enterApp(user) {
        currentUser = user;
        // 账号名可以被重复注册（uuid 会变），所以先确认这批本地数据归属谁
        const state = DB.claim(user.id);
        if (state === 'foreign') {
            showOwnershipPrompt(user);
            return;
        }
        finishEnterApp(user);
    }

    function finishEnterApp(user) {
        if (window.Vehicles) window.Vehicles.ensureDefaultVehicle();
        records = loadRecords();
        lastSyncAt = Number(localStorage.getItem('sb_last_sync') || 0) || 0;

        if (!booted) {
            booted = true;
            if (typeof init === 'function') init();
        } else if (typeof renderAll === 'function') {
            renderAll();
        }

        hideLogin();
        hideSetup();
        setStatus(navigator.onLine ? 'syncing' : 'offline', navigator.onLine ? '同步中…' : '离线');
        renderAccountPanel();
        scheduleSync(150);
        setTimeout(migrateGuestData, 700);
    }

    /**
     * 本机数据的归属和当前账号对不上时，让用户决定：
     *   迁移 → 认领给当前账号，并全部标记为待上传
     *   归档 → 原数据另存到本机另一个键，当前账号从空白开始
     */
    function showOwnershipPrompt(user) {
        const s = DB.summary();
        const when = s.lastModified ? new Date(s.lastModified).toLocaleString() : '未知';
        const names = s.vehicleNames.length
            ? '（' + s.vehicleNames.join('、') + (s.vehicles > s.vehicleNames.length ? ' 等' : '') + '）'
            : '';

        const wrap = document.createElement('div');
        wrap.className = 'login-screen';
        wrap.id = 'ownerPrompt';
        wrap.innerHTML =
            '<div class="login-card">' +
            '<div class="login-logo">📦</div>' +
            '<div class="login-title">本机有一批旧数据</div>' +
            '<div class="login-sub">请确认它是不是属于当前登录的账号</div>' +
            '<div style="background:#f8fafc;border-radius:14px;padding:14px;font-size:13px;line-height:2;color:#334155;margin-bottom:16px">' +
            '记录 <b>' + s.records + '</b> 条 · 里程 <b>' + s.odometer + '</b> 条 · 车辆 <b>' + s.vehicles + '</b> 辆' + names + '<br />' +
            '最后修改：' + when + '<br />' +
            '原归属：<span style="color:#b45309">另一个同名账号（或无法确认）</span>' +
            '</div>' +
            '<button class="login-submit" id="ownerAdopt" style="margin-bottom:10px">迁移到当前账号</button>' +
            '<button class="ghost-btn" id="ownerArchive" style="width:100%">不是我的，归档后清空</button>' +
            '<div class="login-foot">' +
            '迁移：把这批数据认领给当前账号并上传到云端<br />' +
            '归档：先把数据另存到本机，再从当前账号里清空' +
            '</div>' +
            '</div>';
        document.body.appendChild(wrap);

        byId('ownerAdopt').addEventListener('click', () => {
            DB.adopt(user.id);
            DB.markAllDirty();
            wrap.remove();
            finishEnterApp(user);
            scheduleSync(300);
            toast('已迁移到当前账号，正在上传…', 2600);
        });

        byId('ownerArchive').addEventListener('click', () => {
            const key = DB.archive(user.id);
            wrap.remove();
            finishEnterApp(user);
            toast('旧数据已归档，当前账号从空白开始', 2600);
            console.log('[owner] 旧数据归档到', key);
        });
    }

    function boot() {
        loadCfg();
        restoreSession();
        wireLoginUI();
        wireAccountUI();

        if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
            navigator.serviceWorker.register('./sw.js').catch(() => {});
        }

        window.addEventListener('online', () => { toast('网络已恢复，正在同步…', 1200); syncNow(); });
        window.addEventListener('offline', () => setStatus('offline', '离线，联网后自动同步'));

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || !SESSION.access) return;
            if (Date.now() - lastVisibleSync < 20000) return;
            lastVisibleSync = Date.now();
            syncNow();
        });

        setInterval(() => {
            if (document.visibilityState === 'visible' && SESSION.access && !syncing) syncNow();
        }, 60000);

        if (!hasCfg()) {
            setStatus('offline', '未连接服务器');
            showSetup();
            return;
        }
        if (SESSION.refresh && SESSION.user) {
            enterApp(SESSION.user);
        } else {
            setStatus('offline', '未登录');
            showLogin('login');
        }
    }

    window.__boot = boot;
    // 供其他脚本关闭账号面板（这个文件包在 IIFE 里，外部拿不到）
    window.__closeAccount = closeAccount;
    window.scheduleSync = scheduleSync;
    window.SyncNow = syncNow;
})();
