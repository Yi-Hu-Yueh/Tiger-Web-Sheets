import { useEffect, useRef } from 'react'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhTW from '@univerjs/preset-sheets-core/locales/zh-TW'
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets'
import '@univerjs/preset-sheets-core/lib/index.css'

const workbookData = {
  id: 'tiger-phase-0-workbook',
  name: 'Tiger Web Sheets',
  appVersion: '1.0.0',
  locale: LocaleType.ZH_TW,
  sheetOrder: ['sheet-01'],
  sheets: {
    'sheet-01': {
      id: 'sheet-01',
      name: '工作表1',
      rowCount: 100,
      columnCount: 26,
      cellData: {
        0: {
          0: { v: 10 },
          1: { v: '台中公司' },
        },
        1: {
          0: { v: 20 },
        },
        2: {
          0: { f: '=SUM(A1:A2)' },
        },
      },
    },
  },
}

function App() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const { univer, univerAPI } = createUniver({
      locale: LocaleType.ZH_TW,
      locales: {
        [LocaleType.ZH_TW]: mergeLocales(UniverPresetSheetsCoreZhTW),
      },
      presets: [UniverSheetsCorePreset({ container: containerRef.current })],
    })

    univerAPI.createWorkbook(workbookData)

    return () => univer.dispose()
  }, [])

  return <div ref={containerRef} className="univer-shell" aria-label="Tiger Web Sheets" />
}

export default App

