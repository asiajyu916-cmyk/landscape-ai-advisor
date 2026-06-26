import { useState } from 'react'
import PdfReviewPage from '@/pages/PdfReviewPage'
import LandscapeAdvisorPage from '@/pages/LandscapeAdvisorPage'
import DxfReviewPage from '@/pages/DxfReviewPage'

type AppTab = 'pdf' | 'landscape' | 'dxf'

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('landscape')

  // PDF / DXF 導入的植栽名稱清單，橋接到 LandscapeAdvisorPage
  const [importedPlantNames, setImportedPlantNames] = useState<string[]>([])
  // 只有透過 DXF 匯入流程才顯示分區審查摘要
  const [dxfZonesLinked, setDxfZonesLinked] = useState(false)

  const handlePdfImport = (plantNames: string[]) => {
    setImportedPlantNames(plantNames)
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
        onImportConsumed={() => setImportedPlantNames([])}
        dxfZonesLinked={dxfZonesLinked}
      />
      {/* PDF / DXF 頁面的內容渲染在共用 Header 下方 */}
      {activeTab === 'pdf' && (
        <PdfReviewPage
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onImport={handlePdfImport}
        />
      )}
      {activeTab === 'dxf' && (
        <DxfReviewPage
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onImport={handleDxfImport}
        />
      )}
    </>
  )
}
