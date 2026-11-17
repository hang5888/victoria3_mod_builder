# 模組類型：國家開局

> 共用的部分（資料讀取、編輯頁框架、sidebar、選擇器、圖片導入、條件清單、輸出規則）見 [主程式規格](../mod_builder.md)。
> 遊戲檔案格式對照 1.15.1。

設定國家開局時的狀態：可以修改現有國家，也可以新增國家。狀態：規格撰寫中，第 6 節的待確認事項回覆後再開始實作。

範圍（使用者回覆）：

- 對象：修改現有國家＋新增國家。
- 初版包含：法律與政治；科技、財富與識字率；領土；外交；人口；建築；人物。
- 選國家：地圖＋清單。
- 法律頁移過來的「所有國家開局實行」「預設法律」也放在這裡（見 [law.md](law.md) 3.3）。

## 1. 遊戲中的結構

國家的開局分散在很多檔案：

| 部分 | 位置 | 內容 | 原版規模 |
| --- | --- | --- | --- |
| 國家定義 | `common/country_definitions/` | 顏色、等級、類型、主要文化、首都、宗教、社會階層 | 835 個（含 100 個可成立的國家） |
| 國名 | `localization/` | `GBR`（名稱）、`GBR_ADJ`（形容詞）、`GBR_DEF`（正式名稱） | |
| 國旗 | `common/flag_definitions/`、`common/coat_of_arms/coat_of_arms/` | 國旗定義（依條件選用哪個紋章）與紋章圖案 | |
| 國家歷史 | `common/history/countries/` | 法律、科技、執政利益集團、稅率、關稅、制度投資、被課稅商品等 | 450 個檔案，一國一檔 |
| 執政黨 | `common/history/governments/` | 執政黨與政黨聲勢 | 5 國 |
| 財富與識字率 | `common/history/population/` | 人口財富、識字率等級 | 373 個檔案，一國一檔 |
| 領土 | `common/history/states/00_states.txt` | 每個地域由哪些國家擁有哪些省份、家園、宣稱 | 1 個檔案 |
| 人口 | `common/history/pops/` | 每個地區的人口（文化、宗教、職業、人數） | 17 個檔案，依地理區分 |
| 建築 | `common/history/buildings/` | 每個地區的建築（等級、擁有者、生產方式） | 16 個檔案，依地理區分 |
| 人物 | `common/history/characters/`、`common/character_templates/` | 開局的人物（統治者、利益集團領袖、將軍） | 268 個檔案；人物範本 2071 個 |
| 外交 | `common/history/diplomacy/` | 附庸、關係值、宿敵、停戰、禁運、人情 | 6 個檔案 |
| 全局 | `common/history/global/` | 所有開局歷史之後才執行 | 1 個檔案 |

### 1.1 國家定義

```
GBR = {
    color = hsv{ 0.99 0.7 0.9 }
    country_type = recognized
    tier = empire
    cultures = { british scottish }
    capital = STATE_HOME_COUNTIES
}
```

- 欄位使用次數：`cultures`、`tier`、`country_type`、`color` 735；`capital` 734；`dynamic_country_definition` 100；`is_named_from_capital` 91；`regnal_numbers` 63；`religion` 57；`social_hierarchy` 43；部隊顏色 7。
- 國家類型：`recognized`（受承認）、`unrecognized`（未受承認）、`decentralized`（部落）、`colonial`（殖民地）、`company`（公司）。
- 等級：`city_state`、`principality`、`grand_principality`、`kingdom`、`empire`、`hegemony`。
- 國家定義是資料庫，可以用 `REPLACE_OR_CREATE` 覆蓋。

### 1.2 國家歷史（`common/history/countries/`）

```
COUNTRIES = {
    c:GBR ?= {
        effect_starting_technology_tier_1_tech = yes
        add_technology_researched = labor_movement
        set_tax_level = medium
        add_taxed_goods = g:liquor
        set_import_tariff_level = { goods = g:grain level = high_tariffs }
        ig:ig_intelligentsia ?= { add_ruling_interest_group = yes }
        activate_law = law_type:law_monarchy
        set_institution_investment_level = { institution = institution_colonial_affairs level = 2 }
    }
}
```

原版各語句的使用次數：

| 語句 | 次數 | 意思 |
| --- | --- | --- |
| `activate_law` | 1453 | 開局法律 |
| `effect_starting_politics_traditional` 等 5 種 | 413 | 一組開局法律（傳統、保守、反動、自由、土邦） |
| `ig:<利益集團> = { add_ruling_interest_group = yes }` | 190 | 執政利益集團（同一段也有改名、加意識形態） |
| `effect_starting_technology_tier_1_tech` … `tier_7` | 450 | 科技等級（1 最先進，7 最落後） |
| `add_technology_researched` | 137 | 額外的科技 |
| `set_import_tariff_level`、`set_export_tariff_level` | 60、8 | 關稅 |
| `set_institution_investment_level` | 60 | 制度投資等級 |
| `add_taxed_goods` | 52 | 被課消費稅的商品 |
| `set_tax_level` | 27 | 稅率 |
| `set_next_election_date` | 17 | 下次選舉日期 |
| 其他（`add_journal_entry`、`set_variable`、`add_modifier`、`add_company`、主要文化…） | 約 150 | 原樣保留成腳本 |

開局法律的計算方式（之前為法律頁查到的）：大多國家用 `effect_starting_politics_*`，裡面只有「是否為部落國家」「國教是否為伊斯蘭」兩種條件；沒設定的法律組用該組最先讀到的法律。

### 1.3 財富與識字率（`common/history/population/`）

```
POPULATION = {
    c:GBR ?= {
        effect_starting_pop_wealth_very_high = yes
        effect_starting_pop_literacy_high = yes
    }
}
```

財富 4 級（low、medium、high、very_high）、識字率 6 級（very_low、low、baseline、middling、high、very_high），都定義在 `common/scripted_effects/`。

### 1.4 領土（`common/history/states/00_states.txt`）

```
STATES = {
    s:STATE_PROVENCE = {
        create_state = { country = c:SAR owned_provinces = { x5080E0 } }
        create_state = { country = c:FRA owned_provinces = { ... } state_type = unincorporated }
        add_homeland = cu:french
        add_claim = c:SAR
    }
}
```

- 一個地域（state region）可以分給好幾個國家，每個國家擁有其中幾個省份（地區 state）。省份的代碼就是它在 `provinces.png` 上的顏色，工具的地圖已經用這個對應省份。
- `create_state` 1156 次（地域 676 個）；`state_type = unincorporated`（未併入）175 次；`add_homeland` 1340 次；`add_claim` 107 次。
- 一個國家要擁有至少一個地區，開局才會存在。

### 1.5 人口（`common/history/pops/`）

```
POPS = {
    s:STATE_HOME_COUNTIES = {
        region_state:GBR = {
            create_pop = { culture = british size = 2657596 }
            create_pop = { culture = british religion = catholic size = 100000 }
        }
    }
}
```

- `create_pop` 4483 次；欄位：`culture`、`size`（必有）、`religion`（969）、`pop_type`（693）。沒寫宗教用文化的宗教；沒寫職業由遊戲分配。
- 人口記在「地域裡某國的地區」（`region_state:TAG`）底下。

### 1.6 建築（`common/history/buildings/`）

```
BUILDINGS = {
    s:STATE_SVEALAND = {
        region_state:SWE = {
            create_building = {
                building = "building_government_administration"
                add_ownership = { country = { country = "c:SWE" levels = 4 } }
                reserves = 1
                activate_production_methods = { "pm_professional_bureaucrats" "pm_horizontal_drawer_cabinets" }
            }
        }
    }
}
```

- `create_building` 3162 次。擁有者 `add_ownership` 有三種：國家（961）、另一棟建築（2527，例如莊園、金融區）、公司（23）。少數用 `level` 直接給等級。

### 1.7 人物

- 開局人物幾乎都是 `create_character = { template = gbr_queen_victoria_template }`（858／859 次），內容寫在人物範本。
- 人物範本欄位：名、姓、文化、宗教、利益集團、意識形態、特質、出生日期、性別、角色（統治者 `ruler`、繼承人 `heir`、利益集團領袖 `ig_leader`、將軍 `is_general`／指揮官等級）、外觀 `dna`（641 個有）等。

### 1.8 外交（`common/history/diplomacy/`）

- `create_diplomatic_pact = { country = c:X type = ... }`：puppet 64、protectorate 16、colony 15、rivalry 10、vassal 9、tributary 6、personal_union 6、crown_land 5、chartered_company 3、dominion、embargo 等。
- `set_relations = { country = c:SPA value = -30 }`（247 次）、`add_liberty_desire`（20）、停戰 `create_bidirectional_truce`（5）、人情 `set_owes_obligation_to`（4）。

### 1.9 模組怎麼改開局（重要）

- 開局歷史不是資料庫，沒有代碼可以 `REPLACE`；它是依序執行的效果腳本。後面的檔案只能「再加上」效果，沒辦法刪掉前面建立的人口、建築或地區。
- 所以模組改開局的通用做法是**放一個同名檔案，整個取代原本的檔案**。你啟用的模組也是這樣：2932134122 取代美國、巴西等國家歷史；3371693463 取代 `00_states.txt` 和西歐、南歐、東歐的人口與建築檔。
- 地域、人口、建築的檔案是好幾個國家共用一個（`00_states.txt` 是全世界一個檔），取代時必須寫出整個檔案。

## 2. 做法建議（見待確認 1）

〔建議〕**複製目前生效的那個檔案，只換掉這個國家相關的段落**，其他內容（包括註解）原樣保留，寫在同樣的路徑取代原檔：

- 國家歷史、財富與識字率、人物：一國一檔，換掉該國的檔案。
- 領土、人口、建築、外交：換掉含有該國段落的檔案，只改有關的 `s:STATE` 或 `c:TAG` 段落。
- 「目前生效的檔案」是工具讀到的版本：如果已啟用的模組取代過它，就以該模組的版本為基礎，所以會保留它的修改。遊戲中你的模組要排在它後面。
- 新國家另外寫新檔案（國家定義、國家歷史、人物等）；它的領土、人口、建築一樣寫進上面那些被取代的檔案。

## 3. 畫面

| 畫面 | Sidebar | 其他部分 |
| --- | --- | --- |
| 世界畫面（開始畫面） | 模組內容（分類「國家開局」） | 地圖（依開局的國家上色）＋右側國家清單 |
| 編輯畫面 | 同上 | 預覽欄＋編輯區（分頁）；右上角 ✕ 回到世界畫面 |

### 3.0 世界畫面

- 地圖依開局時擁有的國家上色（細到省份，分割的地域會看到好幾個顏色），國家顏色用國家定義的 `color`。點地圖上的國家就打開它。
- 右側清單：搜尋（名稱或代碼）、篩選（國家類型、等級、戰略區域、來源、「你的模組修改的」）。
- 清單最上面是「＋ 新增國家」；〔初版做法〕另有一項「所有國家」，放法律頁移過來的「所有國家開局實行」「預設法律」（見待確認 6）。

### 3.1 預覽欄

- 國名、國旗（〔初版做法〕先用國家顏色的色塊；紋章的圖要由多個圖層合成，見待確認 4）、代碼、類型、等級、首都、主要文化。
- 統計：地區數、人口總數、建築數、人物數、科技等級、執政利益集團。
- 和原版相比改了哪些部分；問題提示。

### 3.2 編輯區（分頁）

| 分頁 | 項目 | 寫成 |
| --- | --- | --- |
| 國家 | 國名／形容詞／正式名稱、顏色、類型、等級、主要文化、首都、宗教、社會階層；新國家另有代碼與國旗 | 國家定義、翻譯、國旗 |
| 政治 | 每個法律組的開局法律（顯示原本的法律，以及它是明確設定、經由開局設定腳本或預設）；執政利益集團（含改名）；稅率；被課稅商品；關稅；制度投資；執政黨；下次選舉日期 | 國家歷史、執政黨 |
| 科技 | 科技等級（1–7）、額外科技、財富等級、識字率等級 | 國家歷史、財富與識字率 |
| 領土 | 地圖上點省份或整個地域給這個國家；已併入／未併入；家園（文化）；宣稱 | 領土 |
| 外交 | 附庸關係（作為宗主或附庸）、關係值、宿敵、停戰、禁運 | 外交 |
| 人口 | 依地區列出人口：文化、宗教、職業、人數；可新增、刪除、改人數 | 人口 |
| 建築 | 依地區列出建築：種類、等級、擁有者、生產方式 | 建築 |
| 人物 | 開局人物清單：用現有人物範本，或新增人物（名字、文化、宗教、利益集團、意識形態、特質、角色） | 人物、人物範本 |
| 其他腳本 | 國家歷史裡工具不認得的語句（日誌、變數、修正、公司…） | 原樣 |

## 4. 輸出（依待確認 1 的回覆）

- 國家定義：`common/country_definitions/zzz_<模組>_countries.txt`（覆蓋用 `REPLACE_OR_CREATE`）。
- 國名：翻譯檔，覆蓋的寫在 `replace/`。
- 國旗（新國家）：`common/flag_definitions/zzz_<模組>_flags.txt`、`common/coat_of_arms/coat_of_arms/zzz_<模組>_coat_of_arms.txt`。
- 國家歷史、財富與識字率、人物：該國的檔案（現有國家用原檔名取代；新國家用 `<代碼> - <名稱>.txt`）。
- 領土、人口、建築、外交：取代含有修改段落的原檔。
- 新的人物範本：`common/character_templates/zzz_<模組>_characters.txt`。
- 「所有國家」的設定：`common/history/global/zzz_<模組>_start.txt`；預設法律寫在 `common/laws/00_00_<模組>_default_laws.txt`（見 law.md 3.3）。

## 5. 初版不做（建議）

- 會依條件改變的國名與國旗（`dynamic_country_definition`、國旗的觸發條件）。
- 新增文化、宗教。
- 軍隊編制與部署、勢力集團、貿易路線、政治運動、遊說團體、外交博弈。
- 人物的外觀（DNA）與肖像。
- 開局歷史裡的日誌、變數、修正、公司：只當腳本原樣保留。

## 6. 待確認事項

1. **修改方式**：
   - A. 複製目前生效的檔案，只換掉這個國家的段落，寫成同名檔案取代原檔（見第 2 節）〔建議〕
   - B. 不取代原檔，只另外寫「再加上」的效果：可以加法律、科技、關係，但不能刪除或搬移原本的人口、建築、領土
   - 回覆：
2. **領土的細度**：
   - A. 細到省份：可以把一個地域分給好幾個國家（和原版一樣）〔建議〕
   - B. 只到整個地域：一個地域只能屬於一個國家，操作比較簡單
   - 回覆：
3. **領土轉移時的人口與建築**：人口和建築記在「某國在某地域的地區」底下，地區換主人時：
   - A. 整個地區轉移時，人口和建築一起轉給新主人；只轉移部分省份時，人口依省份數比例分給兩邊，建築留在原主人〔建議〕
   - B. 一律只轉移土地，人口和建築要自己到人口、建築分頁搬
   - 回覆：
4. **新國家的國旗**：
   - A. 簡化的國旗編輯：選底紋圖案、三個顏色、一個圖案（徽章）〔建議〕
   - B. 複製一個現有國家的國旗，只改顏色
   - C. 導入一張圖片當國旗
   - 回覆：
5. **新國家的開局資料**：
   - A. 新增時先選一個現有國家當範本，複製它的法律、科技、財富等設定再改〔建議〕
   - B. 從空白開始
   - 回覆：
6. **「所有國家」與預設法律**（從法律頁移來）：
   - A. 國家清單最上面放一項「所有國家」，裡面只有「政治」分頁，設定所有國家開局實行的法律與預設法律〔建議〕
   - B. 放在每個法律組的設定裡（法律頁）
   - 回覆：
7. **人物**：
   - A. 可以選現有的人物範本，也可以新增人物；新增的人物寫成人物範本〔建議〕
   - B. 只能選現有的人物範本
   - 回覆：
8. **實作順序**：範圍很大，建議分階段做，每階段都可以用：
   - 第 1 階段：世界畫面、國家分頁（現有國家）、政治、科技
   - 第 2 階段：領土、人口、建築
   - 第 3 階段：外交、人物
   - 第 4 階段：新增國家（國家定義、國旗）
   - 回覆：
9. **入口**：首頁類型卡片、上方導覽、sidebar 分類都加「國家開局」？〔建議：都加〕
   - 回覆：
