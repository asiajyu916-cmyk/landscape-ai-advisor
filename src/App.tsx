import { useState } from 'react'
import PdfReviewPage from '@/pages/PdfReviewPage'
import LandscapeAdvisorPage from '@/pages/LandscapeAdvisorPage'
import DxfReviewPage from '@/pages/DxfReviewPage'

type AppTab = 'pdf' | 'landscape' | 'dxf'

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('landscape')

  // PDF / DXF 導入的植栽名稱清單，橋接到 LandscapeAdvisorPage
  const [importedPlantNames, setImportedPlantNames] = useState<string[]>([])

  const handlePdfImport = (plantNames: string[]) => {
    setImportedPlantNames(plantNames)
    setActiveTab('landscape')
  }

  const handleDxfImport = (plantNames: string[]) => {
    setImportedPlantNames(plantNames)
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
      />
      {/* PDF / DXF 頁面的內容渲染在共用 Header 下方 */}
      {activeTab === 'pdf' && (
        <div className="pt-14 md:pt-[68px]">
          <PdfReviewPage
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onImport={handlePdfImport}
          />
        </div>
      )}
      {activeTab === 'dxf' && (
        <div className="pt-14 md:pt-[68px]">
          <DxfReviewPage
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onImport={handleDxfImport}
          />
        </div>
      )}
    </>
  )
}
