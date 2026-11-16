# 模組類型：奇觀

> 共用的部分（資料讀取、編輯頁框架、sidebar、選擇器、圖片導入、條件清單、輸出規則）見 [主程式規格](../mod_builder.md)。
> 遊戲檔案格式對照 1.15.1。

可以新增奇觀，也可以修改、覆蓋現有的奇觀。狀態：初版已實作（還沒有在遊戲裡實際載入測試，定位點檔與歷史檔的寫法待驗證）。

實作：和工廠共用同一個編輯頁程式（`frontend/js/factory.js` 的 `KINDS.monument`），後端在 `backend/monuments.py`。

範圍：原版 `bg_monuments` 的 25 個奇觀（艾菲爾鐵塔、大本鐘、紫禁城…）和摩天大樓（`bg_skyscraper`）。只用於城市圖像的 23 個隱藏奇觀（`bg_monuments_hidden`）不列。工廠頁不再列出奇觀（見 [factory.md](factory.md)）。

## 1. 遊戲中的結構

一個奇觀由這幾部分組成：

| 部分 | 位置 | 內容 |
| --- | --- | --- |
| 建築 | `common/buildings/` | 群組、圖示、地域限制、建造條件、3D 模型、地圖定位點、建造費用、生產方式組 |
| 生產方式組、生產方式 | `common/production_method_groups/`、`common/production_methods/` | 奇觀的效果（例如國家威望 +100）與僱用 |
| 地圖定位點 | `gfx/map/map_object_data/*.txt` | 3D 模型在地圖上的座標 |
| 翻譯 | `localization/` | 名稱；生產方式組、生產方式的名稱 |

範例（原版 `building_eiffel_tower`，節錄）：

```
building_eiffel_tower = {
    building_group = bg_monuments
    icon = "gfx/interface/icons/building_icons/building_eiffel_tower.dds"
    expandable = no
    downsizeable = no
    unique = yes
    locator = "eiffel_tower_locator"
    entity_not_constructed = { }
    entity_under_construction = { "building_construction_skyscraper_entity" }
    entity_constructed = { "wonder_eiffel_tower_01_entity" }
    city_gfx_interactions = { clear_size_area = yes  size = 3 }
    production_method_groups = { pmg_base_building_eiffel_tower }
    unlocking_technologies = { steel_frame_buildings }
    required_construction = construction_cost_monument
    potential = { state_region = s:STATE_ILE_DE_FRANCE }
    ai_value = 10000
    background = "gfx/interface/icons/building_icons/backgrounds/building_panel_bg_monuments.dds"
}
pm_default_building_eiffel_tower = {
    texture = "gfx/interface/icons/production_method_icons/wonders.dds"
    is_hidden_when_unavailable = yes
    country_modifiers = { workforce_scaled = { country_prestige_add = 100 } }
    building_modifiers = { level_scaled = { building_employment_machinists_add = 100 } }
}
```

定位點（`gfx/map/map_object_data/unique_buildings.txt`，節錄）：

```
game_object_locator={
    name="eiffel_tower_locator"
    clamp_to_water_level=no
    render_under_water=no
    generated_content=no
    layer="static"
    instances={
        { id=1 position={ 4144.299805 0.000000 2720.459961 } rotation={ -0.000000 -0.200000 -0.000000 0.950000 } scale={ 1.000000 1.000000 1.000000 } }
    }
}
```

原版的共同點（25 個中）：

- 都有 `expandable = no`、`downsizeable = no`、`potential`；24 個有 `unique = yes`、`locator`、三個模型欄位、`city_gfx_interactions`。
- 地域限制都寫在 `potential`：`state_region = s:<地域>`，有些再加 `has_dlc_feature` 或擁有者條件。
- 13 個有 `possible`（例如不能是國家無神論），12 個有解鎖科技。
- 8 個 `buildable = no`：遊戲開始時就存在，由 `common/history/buildings/` 的 `create_building` 放置（例如吳哥窟、紫禁城）。
- 每個奇觀有自己的一組生產方式（`pmg_base_building_<奇觀>`）：第一個是它自己的生產方式（效果寫在修正裡），後面接著所有奇觀共用的 `pm_monument_prestige_only`（只有威望）、`pm_monument_no_effects`（沒有效果），讓玩家可以切換。

摩天大樓不同：不是 `unique`，可以由政府在有 `skyscraper_site` 修正的地區蓋（`can_build_government`），沒有定位點與專屬模型，`city_type = city`。

## 2. 資料

除了主程式與工廠已讀的資料，另外讀取：

| 資料 | 用途 | 來源位置 |
| --- | --- | --- |
| 地圖定位點 | 地圖上標出現有奇觀的位置；覆蓋時沿用原本的定位點 | `gfx/map/map_object_data/*.txt` 的 `game_object_locator` |
| 3D 模型 | 模型選項（從現有建築用過的模型中選） | 建築的 `entity_*` 欄位 |

和公司、工廠一樣，重複定義的奇觀記錄所有來源與各來源的版本。

## 3. 畫面

| Sidebar | 預覽欄 | 編輯區 | 右欄 |
| --- | --- | --- | --- |
| 模組內容（分類「奇觀」） | 正在編輯的奇觀 | 各種選項 | 現有的奇觀與摩天大樓（可篩選） |

### 3.1 預覽欄

- 名稱、圖示、背景、群組、所在地域、解鎖科技、建造費用。
- 效果摘要（例如「威望 +100」「虔誠派影響力 +15%」）與僱用。
- 各語言名稱是否已填；問題提示。

### 3.2 編輯區

| 區塊 | 項目 | 寫成 |
| --- | --- | --- |
| 基本資訊 | 代碼（慣例 `building_` 開頭）、名稱、群組（奇觀／摩天大樓） | 定義的鍵、翻譯、`building_group` |
| 圖片 | 圖示、背景（預設奇觀背景）；可選現有或導入 | `icon`、`background` |
| 位置 | 在地圖上選一個地域；再在地圖上點一下放模型的位置（地圖上標出現有奇觀的位置供參考） | `potential` 裡的 `state_region = s:<地域>`；`locator` 與定位點檔 |
| 3D 模型 | 建成後的模型、建造中的模型、建造前的模型（預設空白：不顯示）、城市圖像的大小與清除範圍 | `entity_constructed`、`entity_under_construction`、`entity_not_constructed`、`city_gfx_interactions` |
| 建造 | 解鎖科技、建造費用（預設 `construction_cost_monument`）、玩家可以建造／遊戲開始就存在（見待確認 2）、其他出現條件、建造條件、AI 價值 | `unlocking_technologies`、`required_construction`、`buildable`、`potential`、`possible`、`ai_value` |
| 效果 | 見 3.3 | 生產方式組、生產方式 |
| 其他設置與腳本 | `unique`、`expandable`、`downsizeable` 等其他欄位用表單（新奇觀預設 `unique = yes`、`expandable = no`、`downsizeable = no`）；工具不認得的欄位用腳本 | 原樣 |

- 地域只能選一個；地域的條件和其他出現條件一起寫在 `potential`，其他條件用條件清單編輯。
- 模型位置：地圖畫面上的點換算成定位點座標（x 為橫座標，z 為從地圖下緣算起的縱座標，y 為 0）。換算方式依原版奇觀的定位點與地圖位置推算，實作時以幾個原版奇觀驗證。
- 摩天大樓群組：沒有地域與定位點時不寫 `potential` 的地域條件與 `locator`，其他照用。

### 3.3 效果

見待確認 1，兩種做法：

- 簡化：一張效果清單（修正＋數值＋套用對象：國家／地區／建築），加上僱用（人口類型＋人數）。工具自動寫出這個奇觀自己的一組生產方式（`pmg_base_<代碼>`，裡面是它自己的 `pm_default_<代碼>`，名稱沿用原版的「基礎」「預設生產」），後面照原版接上共用的 `pm_monument_prestige_only`、`pm_monument_no_effects`（保持原樣，畫面上列出）。
- 完整：和工廠一樣的生產方式組編輯（引用現有、複製成自建、直接覆蓋）。

### 3.4 右欄：現有的奇觀

列出遊戲本體與已加載模組中的奇觀與摩天大樓，可篩選：名稱搜尋、來源、群組、所在戰略區域。

- 「修改（覆蓋）」：帶入編輯區修改，輸出後覆蓋原本的奇觀；位置沿用原本的定位點（見待確認 4）。
- 「複製為新奇觀」：當範本；位置、定位點要重新選（同一個定位點不能給兩個奇觀用）。
- 重複定義的奇觀和公司一樣顯示所有來源的標籤，可選擇版本。

## 4. 輸出

- 建築：`common/buildings/zzz_<模組>_monuments.txt`
- 生產方式組、生產方式：`common/production_method_groups/zzz_<模組>_monuments.txt`、`common/production_methods/zzz_<模組>_monuments.txt`
- 定位點：`gfx/map/map_object_data/<模組>_monuments.txt`，每個新奇觀一個 `game_object_locator`，名稱 `<代碼>_locator`。原版也是多個檔案（`unique_buildings.txt`、`american_unique_buildings.txt` 等），所以另開檔案應該會被讀到（待在遊戲裡確認）。
- 翻譯：名稱、生產方式組與生產方式的名稱、修正值翻譯（同工廠），只有填寫的語言；覆蓋的名稱寫在 `replace/`。
- 覆蓋現有奇觀：`REPLACE_OR_CREATE:<代碼> = { ... }`，寫出完整定義。
- 導入的圖片照主程式規格打包。

## 5. 初版不做

- 上傳自己的 3D 模型（只能選現有的模型）。
- 奇觀的分階段外觀（原版皇帝廣場用隱藏奇觀做分階段圖像）。
- 由事件、決議產生奇觀（例如摩天大樓的建築地點修正由決議給予）。

## 6. 已確認事項（使用者回覆）

1. **效果的編輯方式**：簡化的效果清單和完整的生產方式組編輯都支援，由使用者選擇。切換方式會清空原本的效果設定，切換前跳出警告確認。
2. **遊戲開始就存在的奇觀**：支援。
3. **不限地域**：可以。
4. **覆蓋時移動位置**：可以。
5. **入口**：首頁類型卡片、上方導覽、sidebar 分類都加「奇觀」。

依上面的回覆補充的做法〔初版做法，請確認〕：

- **效果方式的預設**：新奇觀預設用效果清單。複製或覆蓋現有奇觀時，如果它只有一組自己的生產方式組，而且組裡第一個生產方式沒有和其他組共用（原版奇觀都是這樣），就用效果清單並帶入第一個生產方式的效果，組裡其他生產方式保持原樣（複製時寫成新的組與生產方式；覆蓋時直接覆蓋那個組與生產方式）；其他情況用完整的生產方式組編輯。
- **遊戲開始就存在**：必須選地域。選了之後再選「由哪個國家擁有」，選項是遊戲開始時在該地域擁有地區的國家（讀 `common/history/states/` 的 `create_state`）。輸出寫 `buildable = no`，並在 `common/history/buildings/zzz_<模組>_monuments.txt` 寫：

  ```
  BUILDINGS = {
      s:STATE_X = {
          region_state:TAG = {
              create_building = { building = "building_x" level = 1 }
          }
      }
  }
  ```

  原版的歷史檔也分成多個檔案，所以另開檔案應該會被讀到（待在遊戲裡確認）。
- **不限地域**：不寫 `potential` 裡的地域條件，也沒有定位點與模型位置；地圖上不放 3D 模型。這時不能選「遊戲開始就存在」。
- **覆蓋時移動位置**：改了地域或點了新位置，就寫一個新的定位點 `<代碼>_locator_<模組>` 並改用它；沒改就沿用原本的定位點。
