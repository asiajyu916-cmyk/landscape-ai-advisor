import { useState } from 'react'
import PdfReviewPage from '@/pages/PdfReviewPage'
import type { ZonePlantingRow } from '@/utils/parsePdfZones'
import type { ZoneReviewResult } from '@/utils/evaluateZone'
import type { LayerOverrideAction } from '@/types/dxf'
import LandscapeAdvisorPage from '@/pages/LandscapeAdvisorPage'
import DxfReviewPage from '@/pages/DxfReviewPage'
import PlantAdvisorChatPage from '@/pages/PlantAdvisorChatPage'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import RequireAuth from '@/components/auth/RequireAuth'
import NoPermissionNotice from '@/components/auth/NoPermissionNotice'
import { hasPermission } from '@/lib/permissions'

type AppTab = 'pdf' | 'landscape' | 'dxf' | 'advisor'

export default function App() {
  return (
    <AuthProvider>
      <RequireAuth>
        <AuthenticatedApp />
      </RequireAuth>
    </AuthProvider>
  )
}

function AuthenticatedApp() {
  const { profile } = useAuth()
  const [activeTab, setActiveTab] = useState<AppTab>('landscape')

  // PDF / DXF 導入的植栽名稱清單，橋接到 LandscapeAdvisorPage
  const [importedPlantNames, setImportedPlantNames] = useState<string[]>([])
  // PDF 分區植栽表（解析結果，空陣列代表失敗）
  const [importedZoneTable, setImportedZoneTable] = useState<ZonePlantingRow[] | undefined>(undefined)
  // 直接傳給 LandscapeAdvisorPage 渲染的分區表，undefined=尚未解析，[]= 解析失敗
  const [zonePlantingTable, setZonePlantingTable] = useState<ZonePlantingRow[] | undefined>(undefined)
  // 分區審查結果，tab 切換後不清空
  const [zoneReviewResults, setZoneReviewResults] = useState<ZoneReviewResult[]>([])
  // 只有透過 DXF 匯入流程才顯示分區審查摘要
  const [dxfZonesLinked, setDxfZonesLinked] = useState(false)

  // ── 人工確認來源批次分類（AI 審查回覆頁的「灌木/地被/草皮/排除」按鈕）────────────
  // 兩個頁面共用同一份狀態：LandscapeAdvisorPage 負責顯示按鈕、寫入這裡；
  // DxfReviewPage 負責把它套進分析管線、立即重跑。key 見 layerOverrideKey()。
  const [layerOverrides, setLayerOverrides] = useState<Map<string, LayerOverrideAction>>(() => {
    try {
      const r = sessionStorage.getItem('dxf-layer-overrides')
      return r ? new Map(JSON.parse(r)) : new Map()
    } catch { return new Map() }
  })
  const applyLayerOverride = (key: string, action: LayerOverrideAction) => {
    setLayerOverrides(prev => {
      const next = new Map(prev)
      next.set(key, action)
      try { sessionStorage.setItem('dxf-layer-overrides', JSON.stringify([...next.entries()])) } catch { /* quota exceeded */ }
      return next
    })
  }
  // DxfReviewPage 重新分析完成後 +1，LandscapeAdvisorPage 依此重讀 sessionStorage
  const [zoneReviewsVersion, setZoneReviewsVersion] = useState(0)
  // 植栽資料庫實際新增/更新/刪除後 +1（LandscapeAdvisorPage 呼叫），DxfReviewPage
  // 依此重新載入植物清單並自動重算目前已載入 DXF 的分區審查，不需要使用者重新上傳圖面。
  const [plantsVersion, setPlantsVersion] = useState(0)

  const handlePdfImport = (plantNames: string[], zoneTable?: ZonePlantingRow[]) => {
    setImportedPlantNames(plantNames)
    setImportedZoneTable(zoneTable)
    setActiveTab('landscape')
  }

  const handleDxfImport = (plantNames: string[]) => {
    setImportedPlantNames(plantNames)
    setDxfZonesLinked(true)   // DXF 分區資料與 AI 配植評估正式連結
    setActiveTab('landscape')
  }

  return (
    <>
      {/* LandscapeAdvisorPage 永遠掛載，其 Header 作為全系統共用 Header */}
      <LandscapeAdvisorPage
        activeTab={activeTab}
        onTabChange={setActiveTab}
        importedPlantNames={importedPlantNames.length > 0 ? importedPlantNames : undefined}
        onImportConsumed={() => { setImportedPlantNames([]); setImportedZoneTable(undefined) }}
        dxfZonesLinked={dxfZonesLinked}
        importedZoneTable={importedZoneTable}
        zonePlantingTable={zonePlantingTable ?? []}
        pdfParsed={zonePlantingTable !== undefined}
        zoneReviewResults={zoneReviewResults}
        layerOverrides={layerOverrides}
        onApplyLayerOverride={applyLayerOverride}
        zoneReviewsVersion={zoneReviewsVersion}
        onPlantsUpdated={() => setPlantsVersion(v => v + 1)}
      />
      {/* PDF / DXF 頁面的內容渲染在共用 Header 下方 —— 沒有權限的分頁不 mount 對應
          元件（不是用 CSS 藏起來），改顯示無權限提示 */}
      {activeTab === 'pdf' && (
        hasPermission(profile?.role, 'canReviewPdf') ? (
          <PdfReviewPage
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onImport={handlePdfImport}
            onZoneParsed={rows => setZonePlantingTable(rows)}
            onZoneReviewed={results => setZoneReviewResults(results)}
          />
        ) : <NoPermissionNotice featureName="PDF 審圖" />
      )}
      {/* DxfReviewPage 只要有權限就永遠掛載（比照上面 LandscapeAdvisorPage 的模式）——
          切離 DXF 分頁時元件自己用 activeTab 決定要不要用 CSS 藏起來，不會 unmount，
          這樣使用者從 AI 配植評估「返回 DXF 分區審查」時不必重新上傳圖面 */}
      {hasPermission(profile?.role, 'canReviewDxf') ? (
        <DxfReviewPage
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onImport={handleDxfImport}
          layerOverrides={layerOverrides}
          onApplyLayerOverride={applyLayerOverride}
          onZoneReviewsUpdated={() => setZoneReviewsVersion(v => v + 1)}
          plantsVersion={plantsVersion}
        />
      ) : (activeTab === 'dxf' && <NoPermissionNotice featureName="DXF 審查" />)}
      {activeTab === 'advisor' && (
        hasPermission(profile?.role, 'canUseAiPlanting')
          ? <PlantAdvisorChatPage />
          : <NoPermissionNotice featureName="AI 配植助理" />
      )}
    </>
  )
}
