# 模組類型：自定義工廠

> 共用的部分（資料讀取、編輯頁框架、sidebar、選擇器、條件清單、輸出規則）見 [主程式規格](../mod_builder.md)。
> 遊戲檔案格式對照 1.15.1。遊戲附的 `buildings.md` 等說明檔有些欄位名稱已過時（例如寫 `production_methods`，實際是 `production_method_groups`），以實際檔案為準。

可以新增工廠（生產建築），也可以修改、覆蓋現有的建築。狀態：初版已實作（還沒有在遊戲裡實際載入測試）。

## 1. 遊戲中的結構

一個工廠由三層組成：

| 層 | 位置 | 內容 |
| --- | --- | --- |
| 建築 | `common/buildings/` | 建築群組、圖示、解鎖科技、建造費用、AI 價值、生產方式組清單等 |
| 生產方式組（PMG） | `common/production_method_groups/` | 建築面板上的一個「欄位」，裡面有幾個可切換的生產方式，同時只有一個生效 |
| 生產方式（PM） | `common/production_methods/` | 投入／產出商品、僱用人口、解鎖科技或法律、其他加成 |

範例（原版 `building_food_industry`）：

```
building_food_industry = {
    building_group = bg_light_industry
    icon = "gfx/interface/icons/building_icons/food_industry.dds"
    city_type = city
    unlocking_technologies = { manufacturies }
    production_method_groups = { pmg_base_building_food_industry pmg_canning ... }
    required_construction = construction_cost_high
    ai_value = { value = 1000 ... }
    ownership_type = self
    background = "gfx/interface/icons/building_icons/backgrounds/building_panel_bg_light_industry.dds"
}
pmg_base_building_food_industry = {
    texture = "gfx/interface/icons/generic_icons/mixed_icon_base.dds"
    production_methods = { pm_bakery pm_sweeteners pm_baking_powder }
}
pm_bakery = {
    texture = "gfx/interface/icons/production_method_icons/bakeries.dds"
    building_modifiers = {
        workforce_scaled = { goods_input_grain_add = 40  goods_output_groceries_add = 45 }
        level_scaled = { building_employment_shopkeepers_add = 500  building_employment_laborers_add = 4500 }
    }
}
```

- 投入／產出寫在 `workforce_scaled`：`goods_input_<商品>_add`、`goods_output_<商品>_add`。
- 僱用寫在 `level_scaled`：`building_employment_<人口類型>_add`。
- 翻譯鍵：建築用建築代碼（例如 `building_food_industry`），生產方式組、生產方式也各用自己的代碼。建築沒有說明文字的鍵。
- 共用情形（1.15.1）：390 個生產方式中有 26 個被多個生產方式組共用；有 5 個生產方式組被多個建築共用。

## 2. 資料

除了主程式的共用資料，另外讀取：

| 資料 | 用途 | 來源位置 |
| --- | --- | --- |
| 建築（全部欄位） | 右欄的現有建築清單、範本 | `common/buildings/` |
| 建築群組 | 群組選項、判斷是否需要地域資源 | `common/building_groups/` |
| 生產方式組、生產方式 | 引用與複製現有的生產方式 | `common/production_method_groups/`、`common/production_methods/` |
| 商品（含基礎價格 `cost`） | 投入／產出選項、利潤試算 | `common/goods/` |
| 人口類型（含 `wage_weight`、`working_adult_ratio`） | 僱用選項、工資估算 | `common/pop_types/` |
| 購買套餐（各生活水平的需求） | 工資估算（見 3.4.1） | `common/buy_packages/` |
| 勞動人口比例 `NPops.WORKING_ADULT_RATIO_BASE` | 工資估算 | `common/defines/` |
| 法律 | 生產方式的解鎖法律選項 | `common/laws/` |
| 建造費用 | 費用選項（`construction_cost_low` 等） | `common/script_values/building_values.txt` |
| 圖片 | 建築圖示、背景、生產方式圖示 | `gfx/interface/icons/building_icons/`、`.../production_method_icons/` 等（加上建築實際引用的路徑） |

和公司一樣，重複定義的建築要記錄所有來源與各來源的版本。

## 3. 畫面

| Sidebar | 預覽欄 | 編輯區 | 右欄 |
| --- | --- | --- | --- |
| 模組內容（分類「工廠」） | 正在編輯的工廠 | 各種選項 | 目前所有的建築（可篩選） |

自建的生產方式組與生產方式屬於各自的工廠，在工廠的編輯頁裡編輯；sidebar 只列工廠。

### 3.1 預覽欄：正在編輯的工廠

- 名稱、圖示、建築群組、解鎖科技、建造費用。
- 每個生產方式組列出它的生產方式（預設的標出來），以及預設組合的投入、產出與利潤試算（見 3.4）。
- 各語言名稱是否已填。
- 問題提示（錯誤擋住儲存，提醒不擋）。

### 3.2 編輯區：建築

| 項目 | 說明 | 寫成 |
| --- | --- | --- |
| 代碼 | 新增時不可與現有建築重複，慣例以 `building_` 開頭 | 定義的鍵 |
| 顯示名稱 | 目前語言的翻譯 | 翻譯檔 |
| 建築群組 | 可經營的生產建築群組：工業（輕、重、軍工、造船）、農業、牧場、種植園、採集（礦場、伐木、漁業、捕鯨、石油、橡膠、金礦） | `building_group` |
| 圖示、背景 | 選現有圖片，或導入自己的（見主程式規格 5.3.1.1） | `icon`、`background` |
| 解鎖科技 | 可多選 | `unlocking_technologies` |
| 建造費用 | 選現有的等級（顯示數值），或填數字；可以不設定 | `required_construction` |
| 城市類型 | 依建築群組自動帶入（取同群組現有建築最常用的類型），可改；背景圖也一樣自動帶入 | `city_type` |
| 建造條件 | 可建造的地方與時機；用條件清單（州範圍：地域是、地區已整合、腳本） | `potential`（能不能出現）、`possible`（現在能不能蓋） |
| AI 價值 | 填數字（寫成 `ai_value = N`）；原本是公式的，改用腳本編輯 | `ai_value` |
| 生產方式組 | 見 3.3 | `production_method_groups` |
| 建築設置 | 其他腳本裡工具認得的欄位，做成表單，見 3.2.1 | 寫在其他腳本裡 |
| 進階 | 工具不認得的欄位的腳本，原樣寫入（例如 `ownership_type`、`levels_per_mesh`、`ai_nationalization_desire`）；新工廠預設填入 `ownership_type = self` 與 `levels_per_mesh = 50` | 原樣 |

新工廠選到農業、牧場、種植園、採集類的群組時，提示：「這類建築要有地域資源才能建造（`arable_resources`／`capped_resources`），工具目前不會修改地域，需要另外處理」。

#### 3.2.1 建築設置（其他腳本的欄位）

建築、生產方式組、生產方式的「其他腳本」裡，工具認得的欄位都做成表單（`frontend/js/scriptfields.js`）。值仍存在其他腳本裡：表單讀取腳本，改動時只改寫那一行（回到遊戲預設值就刪掉那一行），其他內容和註解不受影響。腳本括號不成對時表單停用，文字框改為編輯完整腳本，修正後恢復。

「其他腳本」文字框只顯示工具不認得的欄位（例如模組新增的）；在裡面輸入認得的欄位，離開文字框後會移到表單。

建築的欄位：常用的一直顯示，其他依用途分成可收合的群組；群組裡有已設定的欄位時自動展開，並顯示已設定的數量。

| 群組 | 欄位 |
| --- | --- |
| 常用 | `ownership_type`、`terrain_manipulator`、`levels_per_mesh`、`ai_nationalization_desire`、`buildable`、`expandable`、`downsizeable`、`aliases` |
| 經濟與員工 | `can_switch_owner`、`min_raise_to_hire`、`slaves_role`、`economic_contribution`、`residence_points_per_level`、`generates_residences`、`category_building_type`、`valid_pop_culture_traits`、`investment_scores`（腳本） |
| 建造條件 | `can_build_government`、`can_build_private`（條件清單，州範圍）、`can_have_country_monopoly`（條件清單，國家範圍）、`should_auto_expand`（條件清單，認不出的條件以腳本列保留）、`construction_modifier`（腳本） |
| 其他 | `ignore_stateregion_max_level`、`lens` |

只列生產建築會用到的欄位。奇觀、港口、軍事建築、運河、勢力集團雕像才有的欄位（`unique`、`has_max_level`、`port`、`naval`、`recruits_combat_units`、`recruits_sailors`、`company_headquarter`、`statue`、`enable_air_connection`、`strait`、`locator`、`entity_*`、`city_gfx_interactions`、`meshes`）不在表單裡；從這類建築複製來時，它們留在「其他腳本」。奇觀改在奇觀頁編輯（見 [monument.md](monument.md)）。

生產方式組：`ai_selection`、`is_hidden_when_unavailable`。

生產方式：常用 `required_input_goods`、`disallowing_laws`、`is_hidden_when_unavailable`；「解鎖與限制」`unlocking_production_methods`、`unlocking_global_technologies`、`unlocking_principles`、`unlocking_identity`、`unlocking_company_categories`、`unlocking_geographic_regions`、`unlocking_religions`、`disallowing_religions`、`replacement_if_valid`；「AI 與其他」`profession_ratio`、`ai_weight`、`ai_value`、`scoring_override`、`pollution_generation`、`city_lights_color_index`、`timed_modifiers`（腳本）。

- 控制項依欄位種類：勾選（只寫出和遊戲預設不同的值）、數字、下拉、文字、選一個或多個遊戲物件（科技、法律、商品、人口類型、宗教、原則、勢力集團身份、地理區域、運河、文化特徵、建造菜單分類等，選項從已加載的資料讀取）、條件清單、數值列（職業比例）、腳本框。
- 欄位清單來自原版 1.15.1 實際用到的欄位，加上 `buildings.md`、`production_methods.md` 有記載的欄位。說明檔記載但已過時的欄位不列：`can_build`（遊戲不使用）、`construction_points`（改用 `required_construction`）、`owners`、`ai_privatization_desire`、`production_methods`。
- 會讓生產建築無法使用的欄位，上方一直顯示黃字警告（不彈窗）；設成有問題的值時，警告前加上 ⚠、文字加粗，欄位加上黃框。有警告的欄位：`ownership_type`（不是 self 時）、`terrain_manipulator`（`urban_*`）、`buildable`／`expandable`（取消時）、`aliases`（有值時）。

### 3.3 編輯區：生產方式組

工廠有一張有順序的生產方式組清單，每一組可以是：

| 種類 | 說明 |
| --- | --- |
| 引用現有 | 直接引用遊戲或模組裡現有的組（例如自動化），不修改它；顯示它的生產方式內容，唯讀 |
| 自建 | 屬於這個工廠的組，可以設定代碼、名稱、圖示（預設通用圖示）與其中的生產方式 |

- 引用的組如果沒有其他建築在用（例如覆蓋現有建築時，只有它自己用的組），只顯示「修改」：直接改這個組（寫成同代碼的覆蓋），不需確認。
- 引用的組如果有其他建築共用，卡片上列出這些建築，並提供下面兩種做法。組內引用的生產方式也是同樣的規則。
- 「引用已有的組」的選擇器裡，每個組顯示它第一個生產方式的圖示，以及代碼和使用它的建築。
- 引用現有的組可以「複製成自建」：組和其中的生產方式都複製一份（代碼預設加上 `_copy`，可修改），之後改的是複本，不影響其他建築。這是預設的修改方式。
- 進階：也可以「直接覆蓋」現有的組或生產方式（寫出同代碼的定義）。操作前提示還有哪些建築／生產方式組共用它，確認後才進入編輯。
- 「直接覆蓋」一個組時，組內的生產方式先維持引用；每個引用的生產方式可以再個別「複製成自建」或「直接覆蓋」。自建的組裡也可以加入引用現有的生產方式。
- 一個組至少要有一個生產方式；可以指定預設的生產方式（沒指定時第一個是預設）。
- 清單可以用 ↑ ↓ 調整順序。

每個自建的生產方式可以設定：

| 項目 | 說明 | 寫成 |
| --- | --- | --- |
| 代碼、名稱、圖示 | 代碼不可與現有生產方式重複 | 定義的鍵、翻譯、`texture` |
| 預設 | 是否為組內預設 | `is_default = yes` |
| 投入商品 | 商品＋每級數量 | `building_modifiers.workforce_scaled.goods_input_<商品>_add` |
| 產出商品 | 商品＋每級數量 | `building_modifiers.workforce_scaled.goods_output_<商品>_add` |
| 僱用 | 人口類型＋每級人數 | `building_modifiers.level_scaled.building_employment_<人口>_add` |
| 解鎖科技、解鎖法律 | 可多選 | `unlocking_technologies`、`unlocking_laws` |
| 其他加成 | buff / debuff＋數值＋套用對象（建築、州、國家）與比例方式（依僱用、依等級、不縮放） | `building_modifiers`／`state_modifiers`／`country_modifiers` 的 `workforce_scaled`／`level_scaled`／`unscaled` |
| 其他欄位 | 表單，見 3.2.1；工具不認得的欄位用腳本 | 原樣 |

### 3.4 利潤試算

依商品基礎價格估算（不含市場價格變動）：

- 每個生產方式：投入值＝Σ投入數量 × 價格，產出值＝Σ產出數量 × 價格，每級利潤＝產出值 − 投入值（和遊戲檔案註解的算法相同，例如 1350 − 800 = 550）。
- 工廠：選擇每組的生產方式（預設是各組的預設），顯示組合的總投入、總產出、每級利潤與每級僱用人數。
- 引用現有的組也一起計算。

#### 3.4.1 工資估算

遊戲裡的工資是每座建築依盈虧每週自動調整的，檔案裡沒有固定值，所以這裡用「工人要過多好的生活」來估算：

- 工資權重＝Σ僱用人數 × 該人口類型的 `wage_weight`（`common/pop_types`，沒寫當作 1），也就是「折合多少名工人的工資」。自動化生產方式的僱用是負數，所以工資權重會減少。
- 工人生活水平：預設 10，可在試算表中修改（1–99，對應 `common/buy_packages` 的 `wealth_1`～`wealth_99`）。
- 需求花費＝該等級購買套餐所有 `goods` 數值的總和（每 10000 人每週，以基礎價格計）。模組用 `TRY_INJECT` 加進去的需求也一起加總。
- 每名工人要養的人數＝1 ÷ 工人的 `working_adult_ratio`（沒寫就用 `NPops.WORKING_ADULT_RATIO_BASE`，原版 0.25，即 4 人）。
- 工資率（每 10000 名工人每週）＝需求花費 × 每名工人要養的人數 ÷（1 − 10% 稅）。
- 每級工資＝工資率 × 工資權重 ÷ 10000；扣除工資後的利潤＝每級利潤 − 每級工資。
- 例：原版家具廠「手工家具」，工人 4500＋店主 500（權重 3）＝工資權重 6000；生活水平 10 → 355 × 4 ÷ 0.9 ≈ 1578 → 工資約 947，扣除後 −397；生活水平 5 → 工資約 589，扣除後 −39。
- 右欄的已有建築詳細資料，在利潤後面也顯示目前選擇的生活水平下扣除工資後的利潤。
- 政府出資的建築群組（`is_government_funded = yes`，沒寫就沿用上層群組）由國家預算付工資和投入：不顯示利潤，改顯示「政府每週支出」＝投入 − 產出 + 工資。目前用在奇觀頁（見 [monument.md](monument.md) 3.1）。
- 這只是估算：不含稅制差異、受扶養人口收入、市場價格，也不是遊戲裡的實際工資。

### 3.5 右欄：目前所有的建築

列出遊戲本體與已加載模組中的生產建築（建築群組屬於工業、農業、牧場、種植園、採集，不含自給類），可篩選：名稱搜尋、來源、建築群組、產出商品、投入商品。奇觀、政府、軍事、基礎設施、城鎮設施等不列。

- 建築群組的選項依上下層排列並縮排（例如「制造业」底下是「轻工业」「重工业」）；選上層群組時，底下所有子群組的建築都會列出，數量也包含子群組。

- 「修改（覆蓋）」：帶入編輯區修改，輸出後覆蓋原本的建築；它引用的生產方式組維持「引用現有」，要改時用「複製成自建」或「直接覆蓋」。
- 「複製為新工廠」：當範本建立新工廠；生產方式組預設維持引用，可以再複製成自建。
- 重複定義的建築和公司一樣：顯示所有來源的標籤，展開後可選擇版本。

## 4. 和公司的整合

同一個模組裡的工廠，在公司 builder 中所有選建築的地方都選得到（經營產業、條件清單的「擁有建築」、AI 建造目標），並標示為這個模組的工廠。

## 5. 輸出

- 建築：`common/buildings/zzz_<模組>_buildings.txt`
- 生產方式組：`common/production_method_groups/zzz_<模組>_buildings.txt`
- 生產方式：`common/production_methods/zzz_<模組>_buildings.txt`
- 翻譯（建築、生產方式組、生產方式的名稱，只有填寫的語言）：`localization/<語言>/<模組>_buildings_l_<語言>.yml`；覆蓋現有項目的名稱寫在 `replace/`。
- 覆蓋現有建築、直接覆蓋的生產方式組或生產方式：`REPLACE_OR_CREATE:<代碼> = { ... }`，寫出完整定義。
- 新工廠的修正值翻譯：遊戲會為每個建築自動產生修正值（例如 `building_<代碼>_throughput_add`），工具為有填名稱的語言一併寫出它們的翻譯（含 `_desc`），句型照抄該語言中原版建築的寫法（例如英文 `"$building_x$ building [concept_throughput]"`）。
- 刪除工廠時，一併刪除它自建的生產方式組與生產方式。
- 代碼不可重複：新增的建築、組、生產方式不能和遊戲或已加載模組中現有的相同，也不能和這個模組其他工廠寫出的相同；同一個現有項目只能被一個工廠覆蓋。

## 6. 初版不做

- 修改地域資源（新的農場、礦場、種植園要在地域的 `arable_resources`／`capped_resources` 列出才能建造）。之後可能獨立成一個「地域」模組類型。
- 自訂新商品。
- 上傳自己的 3D 模型（`meshes`、`entity_*` 只能選現有的）。
- 生產方式在多個自建工廠之間共用（每個自建的生產方式組只屬於一個工廠；要共用就引用現有的）。

## 7. 已確認事項

1. `REPLACE_OR_CREATE` 可用於建築、生產方式組、生產方式。
2. 新工廠沒有 3D 模型設定也可以，依 `city_type` 顯示。
3. 自建工廠的修正值翻譯由工具一併輸出（見第 5 節）。

以上三點使用者回覆「不清楚，依建議做」，所以照建議實作；都還沒有在遊戲裡驗證，實際載入後如果有問題再調整。

## 8. 初版的限制

- 讀取現有的生產方式時，`building_modifiers`／`state_modifiers`／`country_modifiers` 裡結構不尋常的內容（不是「縮放方式 = { 修正 = 數值 }」）會整塊保留在「其他腳本」。
- 重新寫出生產方式時，加成依固定順序排列（建築、州、國家；依僱用、依等級、不縮放），和原檔案的順序可能不同，內容不變。
- 只有建築記錄各來源的版本；生產方式組與生產方式只顯示生效的版本。
- 建造條件的清單只有「地域是」「地區已整合」兩種條件，其他以腳本列保留。
