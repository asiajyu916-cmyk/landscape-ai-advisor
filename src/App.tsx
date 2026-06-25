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
      {activeTab === 'pdf' && (
        <PdfReviewPage
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onImport={handlePdfImport}
        />
      )}
      {activeTab === 'landscape' && (
        <LandscapeAdvisorPage
          activeTab={activeTab}
          onTabChange={setActiveTab}
          importedPlantNames={importedPlantNames.length > 0 ? importedPlantNames : undefined}
          onImportConsumed={() => setImportedPlantNames([])}
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
