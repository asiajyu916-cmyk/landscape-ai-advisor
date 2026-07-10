import { useState } from 'react'
import PdfReviewPage from '@/pages/PdfReviewPage'
import type { ZonePlantingRow } from '@/utils/parsePdfZones'
import type { ZoneReviewResult } from '@/utils/evaluateZone'
import LandscapeAdvisorPage from '@/pages/LandscapeAdvisorPage'
import DxfReviewPage from '@/pages/DxfReviewPage'
import PlantAdvisorChatPage from '@/pages/PlantAdvisorChatPage'

type AppTab = 'pdf' | 'landscape' | 'dxf' | 'advisor'

export default function App() {
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
      />
      {/* PDF / DXF 頁面的內容渲染在共用 Header 下方 */}
      {activeTab === 'pdf' && (
        <PdfReviewPage
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onImport={handlePdfImport}
          onZoneParsed={rows => setZonePlantingTable(rows)}
          onZoneReviewed={results => setZoneReviewResults(results)}
        />
      )}
      {activeTab === 'dxf' && (
        <DxfReviewPage
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onImport={handleDxfImport}
        />
      )}
      {activeTab === 'advisor' && <PlantAdvisorChatPage />}
    </>
  )
}
