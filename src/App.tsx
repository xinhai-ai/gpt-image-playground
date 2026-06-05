import { useCallback, useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { mergeImportedSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, loadCustomProviderSettingsFromUrl } from './lib/customProviderConfigUrl'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import { FavoriteCollectionPickerModal, FavoriteCollectionsView, ManageCollectionsModal } from './components/FavoriteCollections'
import { useGlobalClickSuppression } from './lib/clickSuppression'
import AuthGate from './components/AuthGate'
import { isSaasMode } from './lib/saasApi'
import AdminDashboard from './components/AdminDashboard'

let customProviderConfigUrlImportStarted = false

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const saasMode = isSaasMode()
  const [showAdmin, setShowAdmin] = useState(() => saasMode && window.location.hash === '#admin')
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()
  const handleSaasReady = useCallback(() => {
    initStore()
  }, [])

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    const customProviderConfigUrl = getCustomProviderConfigUrl()
    if (customProviderConfigUrl && !customProviderConfigUrlImportStarted) {
      customProviderConfigUrlImportStarted = true
      void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        .then((importedSettings) => {
          if (!importedSettings) return
          const state = useStore.getState()
          state.setSettings(mergeImportedSettings(state.settings, importedSettings))
        })
        .catch((error) => {
          console.warn('Failed to import custom provider config URL:', error)
        })
    }

    if (!saasMode) initStore()
  }, [saasMode, setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  useEffect(() => {
    if (!saasMode) return
    const handleHashChange = () => setShowAdmin(window.location.hash === '#admin')
    window.addEventListener('hashchange', handleHashChange)
    handleHashChange()
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [saasMode])

  const closeAdmin = useCallback(() => {
    if (window.location.hash === '#admin') {
      window.history.pushState(null, '', `${window.location.pathname}${window.location.search}`)
      setShowAdmin(false)
      return
    }
    setShowAdmin(false)
  }, [])

  const app = (
    <>
      {showAdmin ? (
        <AdminDashboard onClose={closeAdmin} />
      ) : (
        <>
          <Header />
          {appMode === 'agent' ? (
            <AgentWorkspace />
          ) : (
            <main data-home-main data-drag-select-surface className="pb-48">
              <div className="safe-area-x max-w-7xl mx-auto">
                <SearchBar />
                {filterFavorite && !activeFavoriteCollectionId ? <FavoriteCollectionsView /> : <TaskGrid />}
              </div>
            </main>
          )}
          <InputBar />
          <DetailModal />
          <Lightbox />
          <SettingsModal />
          <SupportPromptModal />
          <FavoriteCollectionPickerModal />
          <ManageCollectionsModal />
          <MaskEditorModal />
          <ImageContextMenu />
        </>
      )}
      <ConfirmDialog />
      <Toast />
    </>
  )

  return saasMode ? <AuthGate onReady={handleSaasReady}>{app}</AuthGate> : app
}
