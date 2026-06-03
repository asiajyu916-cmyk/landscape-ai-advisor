// ============================================================
// 永豐 AI 建築面積計算平台 — v2 預覽版
// 登入 → 專案列表 → 工作台
// （CDN/Babel 版，供本機 serve.ps1 預覽用；正式版請 npm run dev）
// ============================================================

const { useState, useEffect, useMemo, useRef, useCallback } = React;

// ─────────────────────────────────────────────
// 常數：使用者 / 角色 / 權限
// ─────────────────────────────────────────────

const ROLE_LABEL = { admin: '管理者', architect: '建築師', staff: '專案人員' };

const ROLE_PERMISSIONS = {
  admin:     ['project:create','project:edit','project:delete','project:export','floor:edit','template:edit','version:view','user:manage'],
  architect: ['project:create','project:edit','project:export','floor:edit','version:view'],
  staff:     ['project:edit','project:export','floor:edit'],
};

const MOCK_USERS = [
  { id:'user-lu',    username:'lu',    displayName:'呂建築師',  role:'architect', password:'123456' },
  { id:'user-lee',   username:'lee',   displayName:'李建築師',  role:'architect', password:'123456' },
  { id:'user-chen',  username:'chen',  displayName:'陳建築師',  role:'architect', password:'123456' },
  { id:'user-staff', username:'staff', displayName:'專案人員',  role:'staff',     password:'123456' },
  { id:'user-admin', username:'admin', displayName:'系統管理者',role:'admin',     password:'123456' },
];

const SESSION_KEY = 'yf_v2_session';

const authService = {
  login(username, password) {
    const found = MOCK_USERS.find(u => u.username === username.trim() && u.password === password);
    if (!found) return { data: null, error: '帳號或密碼錯誤' };
    const { password: _, ...user } = found;
    const session = { user, token: `tok_${user.id}_${Date.now()}`, expiresAt: new Date(Date.now() + 8*3600*1000).toISOString() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return { data: session, error: null };
  },
  logout() { localStorage.removeItem(SESSION_KEY); },
  getSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!s || new Date(s.expiresAt) < new Date()) { localStorage.removeItem(SESSION_KEY); return null; }
      return s;
    } catch { return null; }
  },
  hasPermission(permission, role) {
    return (ROLE_PERMISSIONS[role] || []).includes(permission);
  },
  getUsers() { return MOCK_USERS.map(({ password: _, ...u }) => u); },
};

// ─────────────────────────────────────────────
// MOCK 專案資料
// ─────────────────────────────────────────────

const PROJECTS_KEY = 'yf_v2_projects';

const INITIAL_MOCK_PROJECTS = [
  {
    id: 'proj-001',
    name: 'XX集合住宅新建工程',
    location: '台中市南屯區大墩段 852、853、853-1',
    zoning: '第四種住宅區',
    buildingType: '集合住宅',
    siteArea: 2591.00,
    legalBCR: 60, legalFAR: 500,
    status: 'reviewing',
    responsibleArchitect: '呂建築師',
    projectStaff: '專案人員',
    createdBy: 'user-lu',
    updatedAt: '2026-06-03T14:35:00Z',
    createdAt: '2025-01-15T09:00:00Z',
  },
  {
    id: 'proj-002',
    name: 'YY辦公大樓新建工程',
    location: '台北市信義區信義段 101、102',
    zoning: '商業區',
    buildingType: '辦公大樓',
    siteArea: 1850.00,
    legalBCR: 60, legalFAR: 560,
    status: 'draft',
    responsibleArchitect: '李建築師',
    projectStaff: '-',
    createdBy: 'user-lee',
    updatedAt: '2026-05-20T11:20:00Z',
    createdAt: '2025-03-10T09:00:00Z',
  },
  {
    id: 'proj-003',
    name: 'ZZ透天厝新建工程',
    location: '台南市東區勝利段 321',
    zoning: '第二種住宅區',
    buildingType: '透天住宅',
    siteArea: 320.00,
    legalBCR: 60, legalFAR: 240,
    status: 'finalized',
    responsibleArchitect: '陳建築師',
    projectStaff: '-',
    createdBy: 'user-chen',
    updatedAt: '2026-02-28T16:00:00Z',
    createdAt: '2024-11-05T09:00:00Z',
  },
];

function getProjects() {
  try { return JSON.parse(localStorage.getItem(PROJECTS_KEY) || 'null') || INITIAL_MOCK_PROJECTS; }
  catch { return INITIAL_MOCK_PROJECTS; }
}
function saveProjects(list) { localStorage.setItem(PROJECTS_KEY, JSON.stringify(list)); }
function seedProjects() {
  if (!localStorage.getItem(PROJECTS_KEY)) saveProjects(INITIAL_MOCK_PROJECTS);
}

// ─────────────────────────────────────────────
// 登入頁
// ─────────────────────────────────────────────

const TEST_ACCOUNTS = [
  { label:'呂建築師',  username:'lu',    role:'建築師' },
  { label:'李建築師',  username:'lee',   role:'建築師' },
  { label:'陳建築師',  username:'chen',  role:'建築師' },
  { label:'專案人員',  username:'staff', role:'專案人員' },
  { label:'系統管理者',username:'admin', role:'管理者' },
];

function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) { setError('請輸入帳號與密碼'); return; }
    setLoading(true);
    setTimeout(() => {
      const result = authService.login(username, password);
      setLoading(false);
      if (result.error) { setError(result.error); return; }
      onLogin(result.data);
    }, 300);
  };

  const fill = (uname) => { setUsername(uname); setPassword('123456'); setError(null); };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-950 via-blue-900 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 shadow-lg mb-4">
            <span className="text-white text-2xl font-bold">YF</span>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-wide">永豐 AI 建築面積計算平台</h1>
          <p className="text-blue-300 text-sm mt-1.5">公司內部建築面積計算系統</p>
        </div>

        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-base font-semibold text-gray-700 mb-5">登入帳號</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">帳號</label>
              <input type="text" value={username} onChange={e=>{setUsername(e.target.value);setError(null)}}
                placeholder="請輸入帳號（如：lu、lee、admin）"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus disabled={loading} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">密碼</label>
              <input type="password" value={password} onChange={e=>{setPassword(e.target.value);setError(null)}}
                placeholder="請輸入密碼"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={loading} />
            </div>
            {error && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                {error}
              </div>
            )}
            <button type="submit" disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm flex items-center justify-center gap-2 mt-2">
              {loading ? (
                <><svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>登入中...</>
              ) : '登　入'}
            </button>
          </form>

          {/* 測試帳號 */}
          <div className="mt-6 pt-5 border-t border-gray-100">
            <p className="text-xs font-medium text-gray-400 mb-2">測試帳號（點選自動填入）</p>
            <div className="grid grid-cols-1 gap-1.5">
              {TEST_ACCOUNTS.map(a => (
                <button key={a.username} type="button" onClick={() => fill(a.username)}
                  className="flex items-center justify-between px-3 py-1.5 rounded-lg border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-colors text-left group">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-700 group-hover:text-blue-700">{a.label}</span>
                    <span className="text-xs text-gray-400">帳號：{a.username}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-300 bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5">{a.role}</span>
                    <svg className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                  </div>
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-300 mt-2 text-center">所有帳號密碼均為 123456</p>
          </div>
        </div>
        <p className="text-center text-blue-400/60 text-xs mt-6">© 永豐建設 · 建築面積計算平台 v2 · 公司內部系統</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 使用者選單（右上角下拉）
// ─────────────────────────────────────────────

function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const roleLabel = ROLE_LABEL[user.role];
  const roleColor = user.role === 'admin' ? 'bg-red-50 text-red-600 border-red-200'
    : user.role === 'architect' ? 'bg-blue-50 text-blue-600 border-blue-200'
    : 'bg-gray-50 text-gray-600 border-gray-200';

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors">
        <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
          <span className="text-white text-xs font-semibold">{user.displayName[0]}</span>
        </div>
        <div className="text-left">
          <div className="text-sm font-medium text-gray-700 leading-tight">{user.displayName}</div>
          <div className="text-xs text-gray-400 leading-tight">{roleLabel}</div>
        </div>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-xl border border-gray-200 py-1 z-50">
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                <span className="text-white text-sm font-semibold">{user.displayName[0]}</span>
              </div>
              <div>
                <div className="text-sm font-semibold text-gray-800">{user.displayName}</div>
                <span className={`text-xs rounded px-1.5 py-0.5 border font-medium mt-0.5 inline-block ${roleColor}`}>{roleLabel}</span>
              </div>
            </div>
          </div>
          <div className="border-t border-gray-100 py-1">
            <button onClick={() => { setOpen(false); authService.logout(); onLogout(); }}
              className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 font-medium">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
              登出
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 專案列表頁
// ─────────────────────────────────────────────

const STATUS_LABEL = { draft:'草稿', reviewing:'審查中', finalized:'已定稿' };
const STATUS_COLOR = {
  draft:     'bg-gray-100 text-gray-600 border-gray-200',
  reviewing: 'bg-amber-50 text-amber-700 border-amber-200',
  finalized: 'bg-green-50 text-green-700 border-green-200',
};

function NewProjectModal({ session, onClose, onCreate }) {
  const architects = authService.getUsers().filter(u => u.role === 'architect');
  const allUsers   = authService.getUsers();
  const [form, setForm] = useState({
    name:'', location:'', zoning:'第四種住宅區', buildingType:'集合住宅',
    siteArea:'', legalBCR:'60', legalFAR:'500',
    responsibleArchitect: session.user.role === 'architect' ? session.user.displayName : (architects[0]?.displayName || ''),
    projectStaff:'',
  });
  const [error, setError] = useState('');
  const inp = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('請輸入工程名稱'); return; }
    if (!form.siteArea || isNaN(Number(form.siteArea))) { setError('請輸入正確的基地面積'); return; }
    const now = new Date().toISOString();
    const project = {
      id: `proj-${Date.now()}`,
      name: form.name.trim(), location: form.location.trim(),
      zoning: form.zoning, buildingType: form.buildingType,
      siteArea: Number(form.siteArea), legalBCR: Number(form.legalBCR), legalFAR: Number(form.legalFAR),
      status: 'draft',
      responsibleArchitect: form.responsibleArchitect,
      projectStaff: form.projectStaff,
      createdBy: session.user.id,
      updatedAt: now, createdAt: now,
    };
    const list = getProjects();
    list.unshift(project);
    saveProjects(list);
    onCreate(project.id);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[540px] max-h-[92vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-base font-bold text-gray-800">新增專案</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">工程名稱 <span className="text-red-500">*</span></label>
            <input className={inp} placeholder="例：XX集合住宅新建工程" value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">建築地點</label>
            <input className={inp} placeholder="例：台中市南屯區大墩段" value={form.location} onChange={e=>setForm(p=>({...p,location:e.target.value}))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">使用分區</label>
              <input className={inp} value={form.zoning} onChange={e=>setForm(p=>({...p,zoning:e.target.value}))} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">建築類別</label>
              <select className={inp} value={form.buildingType} onChange={e=>setForm(p=>({...p,buildingType:e.target.value}))}>
                <option>集合住宅</option><option>透天住宅</option><option>辦公大樓</option><option>商業大樓</option><option>其他</option>
              </select></div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">基地面積(㎡) <span className="text-red-500">*</span></label>
              <input className={inp} type="number" step="0.01" placeholder="2591.00" value={form.siteArea} onChange={e=>setForm(p=>({...p,siteArea:e.target.value}))} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">建蔽率(%)</label>
              <input className={inp} type="number" value={form.legalBCR} onChange={e=>setForm(p=>({...p,legalBCR:e.target.value}))} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">容積率(%)</label>
              <input className={inp} type="number" value={form.legalFAR} onChange={e=>setForm(p=>({...p,legalFAR:e.target.value}))} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">負責建築師</label>
              <select className={inp} value={form.responsibleArchitect} onChange={e=>setForm(p=>({...p,responsibleArchitect:e.target.value}))}>
                <option value="">— 未指定 —</option>
                {architects.map(u=><option key={u.id}>{u.displayName}</option>)}
              </select></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">專案人員</label>
              <select className={inp} value={form.projectStaff} onChange={e=>setForm(p=>({...p,projectStaff:e.target.value}))}>
                <option value="">— 未指定 —</option>
                {allUsers.map(u=><option key={u.id}>{u.displayName}</option>)}
              </select></div>
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">取消</button>
            <button type="submit" className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium">建立專案</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProjectListPage({ session, onOpenProject, onLogout }) {
  const [projects, setProjects] = useState(() => getProjects());
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);

  const canCreate = authService.hasPermission('project:create', session.user.role);
  const canDelete = authService.hasPermission('project:delete', session.user.role);

  const handleDelete = (id, name) => {
    if (!confirm(`確定要刪除「${name}」？`)) return;
    const next = projects.filter(p => p.id !== id);
    setProjects(next); saveProjects(next);
  };

  const handleDuplicate = (p) => {
    const now = new Date().toISOString();
    const copy = { ...p, id: `proj-${Date.now()}`, name: `${p.name}（副本）`, status: 'draft', updatedAt: now, createdAt: now };
    const next = [copy, ...projects];
    setProjects(next); saveProjects(next);
  };

  const filtered = projects.filter(p =>
    !search ||
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.location.toLowerCase().includes(search.toLowerCase()) ||
    (p.responsibleArchitect||'').includes(search)
  );

  const fmtDate = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };

  const th = "px-4 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap";

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 頂部導覽 */}
      <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-40">
        <div className="max-w-screen-xl mx-auto px-6 h-14 flex items-center gap-4">
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 bg-blue-700 rounded flex items-center justify-center">
              <span className="text-white text-xs font-bold">YF</span>
            </div>
            <span className="font-semibold text-gray-800 text-sm whitespace-nowrap">永豐 AI 建築面積計算平台</span>
          </div>
          <div className="flex-1" />
          <UserMenu user={session.user} onLogout={onLogout} />
        </div>
      </header>

      <main className="max-w-screen-xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-800">專案列表</h1>
            <p className="text-sm text-gray-500 mt-0.5">共 {projects.length} 個專案</p>
          </div>
          <div className="flex items-center gap-3">
            <input type="text" placeholder="搜尋名稱 / 地點 / 負責建築師..." value={search} onChange={e=>setSearch(e.target.value)}
              className="w-64 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white" />
            {canCreate && (
              <button onClick={() => setShowNew(true)}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
                <span className="text-base leading-none">＋</span>新增專案
              </button>
            )}
          </div>
        </div>

        {/* staff 權限提示 */}
        {session.user.role === 'staff' && (
          <div className="mb-4 flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-xs px-4 py-2.5 rounded-lg">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            您的角色為「專案人員」，可開啟並編輯面積資料，但無法新增或刪除專案。
          </div>
        )}

        {/* 表格 */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['專案名稱','基地座落','使用分區','建築類型','負責建築師','專案人員','最後修改','狀態','操作'].map(h=>(
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-sm text-gray-400">
                  {search ? '查無符合的專案' : '尚無專案'}
                </td></tr>
              ) : filtered.map((p, i) => (
                <tr key={p.id} className={`border-b border-gray-100 hover:bg-blue-50/30 transition-colors ${i%2!==0?'bg-gray-50/30':''}`}>
                  <td className="px-4 py-3">
                    <button onClick={() => onOpenProject(p.id)}
                      className="font-medium text-blue-700 hover:text-blue-900 hover:underline text-left">
                      {p.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs max-w-[180px] truncate" title={p.location}>{p.location||'-'}</td>
                  <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">{p.zoning||'-'}</td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{p.buildingType}</td>
                  <td className="px-4 py-3">
                    {p.responsibleArchitect ? (
                      <div className="flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                          <span className="text-blue-600 text-xs font-semibold">{p.responsibleArchitect[0]}</span>
                        </div>
                        <span className="text-xs text-gray-700">{p.responsibleArchitect}</span>
                      </div>
                    ) : <span className="text-xs text-gray-300">-</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">{p.projectStaff||'-'}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{fmtDate(p.updatedAt)}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs border rounded px-2 py-0.5 font-medium ${STATUS_COLOR[p.status]||STATUS_COLOR.draft}`}>
                      {STATUS_LABEL[p.status]||p.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button onClick={() => onOpenProject(p.id)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">開啟</button>
                      {(session.user.role === 'architect' || session.user.role === 'admin') && (
                        <><span className="text-gray-200">|</span>
                        <button onClick={() => handleDuplicate(p)} className="text-xs text-gray-500 hover:text-gray-700">複製</button></>
                      )}
                      {canDelete && (
                        <><span className="text-gray-200">|</span>
                        <button onClick={() => handleDelete(p.id, p.name)} className="text-xs text-red-400 hover:text-red-600">刪除</button></>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-6 flex items-center justify-between text-xs text-gray-400">
          <span>顯示 {filtered.length} / {projects.length} 個專案</span>
          <span>登入身分：{session.user.displayName}（{ROLE_LABEL[session.user.role]}）</span>
        </div>
      </main>

      {showNew && (
        <NewProjectModal session={session} onClose={() => setShowNew(false)}
          onCreate={(id) => { setShowNew(false); onOpenProject(id); }} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 工作台（嵌入 app.js 的主要邏輯）
// ─────────────────────────────────────────────
// app.js 所有元件已在同一 Babel runtime 中可用，
// 這裡只建立一個帶有「返回」按鈕的包裝層。

function WorkbenchWrapper({ projectId, session, onBack }) {
  // 取得專案資料
  const project = getProjects().find(p => p.id === projectId) || { name: '專案' };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* 最小化頂部列（帶返回按鈕 + 使用者） */}
      <div style={{ height: 52 }} className="flex items-center px-4 bg-white border-b border-gray-200 gap-4 shrink-0 shadow-sm z-10">
        <button onClick={onBack} className="flex items-center gap-1.5 text-gray-500 hover:text-blue-700 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
          <span className="text-xs font-medium">專案列表</span>
        </button>
        <div className="w-px h-5 bg-gray-200" />
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 bg-blue-700 rounded flex items-center justify-center">
            <span className="text-white text-xs font-bold">YF</span>
          </div>
          <span className="font-semibold text-gray-800 text-sm whitespace-nowrap">永豐 AI 建築面積計算平台</span>
        </div>
        <div className="w-px h-5 bg-gray-200" />
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500">專案：</span>
          <span className="text-sm font-medium text-gray-700">{project.name}</span>
        </div>
        <div className="flex-1" />
        {/* 使用者 */}
        <div className="flex items-center gap-1.5">
          <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center">
            <span className="text-white text-xs font-semibold">{session.user.displayName[0]}</span>
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-xs font-medium text-gray-700">{session.user.displayName}</span>
            <span className="text-xs text-gray-400">{ROLE_LABEL[session.user.role]}</span>
          </div>
        </div>
        <button onClick={onBack} className="text-xs text-gray-400 hover:text-red-600 border border-gray-200 rounded px-2.5 py-1 hover:border-red-200 transition-colors ml-1">
          登出
        </button>
      </div>
      {/* 嵌入 app.js 的 App 元件（工作台本體） */}
      <WorkbenchOnly session={session} />
    </div>
  );
}

// app.js 的 App 元件（原本獨立，這裡提取工作台本體）
function WorkbenchOnly({ session }) {
  const [activeMenu,    setActiveMenu]    = useState('3');
  const [floorsById,    setFloorsById]    = useState(() => buildInitialFloorsById());
  const [activeFloorId, setActiveFloorId] = useState('5F');
  const [exportModal,   setExportModal]   = useState(null);
  const [projectInfo,   setProjectInfo]   = useState(INITIAL_PROJECT_INFO_WB);

  return (
    <div className="flex flex-1 overflow-hidden" style={{ height: 'calc(100vh - 52px)' }}>
      <SidebarWB activeId={activeMenu} onSelect={setActiveMenu} />
      {activeMenu === '3'
        ? <Step3PanelWB
            floorsById={floorsById} setFloorsById={setFloorsById}
            activeFloorId={activeFloorId} setActiveFloorId={setActiveFloorId}
          />
        : <PlaceholderWB stepId={activeMenu} />
      }
      <RightPanelWB floorsById={floorsById} activeFloorId={activeFloorId} projectInfo={projectInfo} />
      {exportModal && <ExportModalWB type={exportModal} floorsById={floorsById} projectInfo={projectInfo} onClose={() => setExportModal(null)} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// 以下為 app.js 元件的別名引用（避免衝突）
// app.js 會在同一個 Babel 執行環境中被載入
// ─────────────────────────────────────────────
// 注意：app.js 中已定義 INITIAL_PROJECT_INFO、buildInitialFloorsById 等
// 此處用別名避免重複宣告衝突

const INITIAL_PROJECT_INFO_WB = typeof INITIAL_PROJECT_INFO !== 'undefined' ? INITIAL_PROJECT_INFO : {};
const SidebarWB      = typeof Sidebar      !== 'undefined' ? Sidebar      : () => null;
const Step3PanelWB   = typeof Step3Panel   !== 'undefined' ? Step3Panel   : () => null;
const PlaceholderWB  = typeof PlaceholderPanel !== 'undefined' ? PlaceholderPanel : () => null;
const RightPanelWB   = typeof RightPanel   !== 'undefined' ? RightPanel   : () => null;
const ExportModalWB  = typeof ExportModal  !== 'undefined' ? ExportModal  : () => null;

// ─────────────────────────────────────────────
// ROOT APP（登入 → 專案列表 → 工作台）
// ─────────────────────────────────────────────

function AppV2() {
  const [view,      setView]      = useState('login');
  const [session,   setSession]   = useState(null);
  const [projectId, setProjectId] = useState(null);

  useEffect(() => {
    seedProjects();
    const existing = authService.getSession();
    if (existing) { setSession(existing); setView('projects'); }
  }, []);

  const handleLogin = (s) => { setSession(s); setView('projects'); };
  const handleLogout = () => { authService.logout(); setSession(null); setProjectId(null); setView('login'); };
  const handleOpenProject = (id) => { setProjectId(id); setView('workbench'); };
  const handleBack = () => { setProjectId(null); setView('projects'); };

  if (view === 'login' || !session)
    return <LoginPage onLogin={handleLogin} />;
  if (view === 'projects')
    return <ProjectListPage session={session} onOpenProject={handleOpenProject} onLogout={handleLogout} />;
  if (view === 'workbench' && projectId)
    return <WorkbenchWrapper projectId={projectId} session={session} onBack={handleBack} />;
  return null;
}

// app.js 已在 index.html 設定 window.__YF_V2__ = true，不會自動 render
// app-v2.js 在這裡統一掛載
const v2Root = ReactDOM.createRoot(document.getElementById('root'));
v2Root.render(<AppV2 />);
