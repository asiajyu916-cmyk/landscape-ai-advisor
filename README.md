# 永豐 AI 建築面積計算平台

公司內部線上 Web App，用於建築面積計算、容積率檢討、送審格式大總表產製。

## 快速開始

```bash
# 安裝 Node.js（需要 v18+）
# https://nodejs.org/

# 安裝依賴
npm install

# 本機開發（http://localhost:3001）
npm run dev

# 建置正式版（輸出到 dist/）
npm run build
```

## 測試帳號

| 角色 | 帳號 | 密碼 |
|------|------|------|
| 管理員 | admin@yungfong.com | 123456 |
| 建築師 | arch01@yungfong.com | 123456 |
| 檢視者 | viewer@yungfong.com | 123456 |

## 專案結構

```
src/
├── types/index.ts           # TypeScript 型別定義
├── services/
│   ├── authService.ts       # 登入/登出（localStorage → Supabase Auth）
│   └── projectService.ts    # 專案 CRUD（localStorage → Supabase DB）
├── utils/calculations.ts    # 純函式計算邏輯（無副作用）
├── data/
│   ├── mockData.ts          # 初始 mock 資料
│   └── floorDefinitions.ts  # 樓層 meta 定義
├── pages/
│   ├── LoginPage.tsx        # 登入頁
│   ├── ProjectListPage.tsx  # 專案列表頁
│   └── WorkbenchPage.tsx    # 建築面積計算工作台
└── App.tsx                  # 頁面路由
```

## 未來接 Supabase

1. `npm install @supabase/supabase-js`
2. 建立 `src/lib/supabase.ts`
3. 在 `authService.ts` 替換 `authService.login()` 為 `supabase.auth.signInWithPassword()`
4. 在 `projectService.ts` 替換 localStorage 操作為 `supabase.from('projects')...`
5. 設定 `.env` 中的 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`

## 部署到 Vercel

1. 推送到 GitHub
2. 在 Vercel 新增專案，選擇 GitHub repo
3. Framework: Vite
4. Build command: `npm run build`
5. Output directory: `dist`
6. 設定環境變數（Supabase keys）
