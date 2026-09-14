import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { List } from "@kilocode/kilo-ui/list"
import { ProviderIcon } from "@kilocode/kilo-ui/provider-icon"
import { Tag } from "@kilocode/kilo-ui/tag"
import { Show, createMemo } from "solid-js"
import { useLanguage } from "../../context/language"
import { CUSTOM_PROVIDER_ID, providerIcon } from "./provider-catalog"
import CustomProviderDialog from "./CustomProviderDialog"
import { CUSTOM_ONLY_UNSUPPORTED } from "./provider-tab-helpers"
import type { Provider } from "../../types/messages"

type ProviderItem = {
  id: string
  name: string
  provider?: Provider
}

const ProviderSelectDialog = () => {
  const dialog = useDialog()
  const language = useLanguage()

  // Temporary custom-only boundary: built-in provider selection is hidden.
  // Only the custom provider entry remains; dormant built-in catalog logic
  // is retained in history but not rendered.
  const items = createMemo<ProviderItem[]>(() => {
    language.locale()
    return [
      {
        id: CUSTOM_PROVIDER_ID,
        name: language.t("settings.providers.tag.customProvider"),
      },
    ]
  })

  function open(item: ProviderItem) {
    if (item.id === CUSTOM_PROVIDER_ID) {
      dialog.show(() => <CustomProviderDialog onBack={() => dialog.show(() => <ProviderSelectDialog />)} />)
      return
    }
  }

  return (
    <Dialog title={language.t("command.provider.connect")} size="large" transition>
      <div style={{ padding: "0 0 8px 0", "font-size": "var(--kilo-font-size-12)", color: "var(--vscode-descriptionForeground)" }}>
        {CUSTOM_ONLY_UNSUPPORTED}
      </div>
      <List<ProviderItem>
        search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.provider.empty")}
        activeIcon="plus-small"
        key={(item) => item.id}
        items={items()}
        filterKeys={["id", "name"]}
        groupBy={() => language.t("dialog.provider.group.other")}
        sortBy={(a, b) => {
          if (a.id === CUSTOM_PROVIDER_ID) return -1
          if (b.id === CUSTOM_PROVIDER_ID) return 1
          return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
        }}
        sortGroupsBy={(a, b) => a.category.localeCompare(b.category)}
        onSelect={(item) => {
          if (!item) return
          open(item)
        }}
      >
        {(item) => (
          <div style={{ display: "flex", gap: "10px", "align-items": "center", width: "100%", "min-width": 0 }}>
            <ProviderIcon
              id={providerIcon(item.provider ?? item.id)}
              width={18}
              height={18}
              data-slot="list-item-extra-icon"
            />
            <div
              style={{
                display: "flex",
                gap: "8px",
                "align-items": "center",
                "min-width": 0,
                flex: 1,
                "flex-wrap": "wrap",
              }}
            >
              <span
                style={{
                  "font-size": "var(--kilo-font-size-14)",
                  "line-height": "var(--kilo-font-size-20)",
                  color: "var(--vscode-foreground)",
                }}
              >
                {item.name}
              </span>
              <Show when={item.id === CUSTOM_PROVIDER_ID}>
                <Tag>{language.t("settings.providers.tag.custom")}</Tag>
              </Show>
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}

export default ProviderSelectDialog
