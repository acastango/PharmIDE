# Product Unit Conversion System — Spec

## The Problem

Pharmacy inventory is confusing because the same product can be measured in multiple units. Lantus Solostar is simultaneously 3 boxes, 15 pens, and 45 mL — all correct, all describing the same amount of insulin on the shelf. Different pharmacies, different pharmacists, different conventions. New techs have to learn the conversion math by osmosis and mistakes happen.

Every other pharmacy system picks one unit and forces everyone to think in that unit. PharmIDE stores one truth (base units) and displays all representations simultaneously.

---

## Architecture

### Core Principle

Every product has one **base unit** — the smallest meaningful physical measure. All other units are conversion ratios on top of it. Inventory is stored exclusively in base units. Display is a division problem.

```
Inventory on hand: 45 (base unit: mL)
Display: 3 boxes │ 15 pens │ 45 mL
         (45÷15)   (45÷3)    (45÷1)
```

### Two-Layer Resolution

1. **Form-level defaults** — covers ~90% of products automatically. "All pens are 3mL per pen, 5 pens per box."
2. **NDC-level overrides** — for exceptions. "This specific Victoza pen is 3mL but concentration is 6mg/mL, not 100 units/mL."

System checks NDC overrides first. If no override exists for that NDC + unit_name, falls back to form defaults.

---

## Database Schema

### `form_unit_defaults` — in `pharmide.db`

Covers entire dosage form categories. Preloaded on install.

```sql
CREATE TABLE IF NOT EXISTS form_unit_defaults (
    form TEXT NOT NULL,                -- "pen", "inhaler_mdi", "tablet", "cream", etc.
    unit_name TEXT NOT NULL,           -- "mL", "pen", "box", "actuation", "each"
    base_equivalent REAL NOT NULL,     -- How many base units this equals
    is_base BOOLEAN NOT NULL DEFAULT 0,
    is_dispensable BOOLEAN NOT NULL DEFAULT 0,
    is_billing BOOLEAN NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,  -- Lower = shown first in UI
    PRIMARY KEY (form, unit_name)
);
```

### `product_unit_overrides` — in `pharmide.db`

Per-NDC exceptions. Only populated when a product deviates from its form default.

```sql
CREATE TABLE IF NOT EXISTS product_unit_overrides (
    ndc TEXT NOT NULL,
    unit_name TEXT NOT NULL,
    base_equivalent REAL NOT NULL,
    is_base BOOLEAN NOT NULL DEFAULT 0,
    is_dispensable BOOLEAN NOT NULL DEFAULT 0,
    is_billing BOOLEAN NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ndc, unit_name)
);
```

### `product_concentration` — in `pharmide.db`

Links the physical volume to active ingredient content. Needed for days supply calculation.

```sql
CREATE TABLE IF NOT EXISTS product_concentration (
    ndc TEXT PRIMARY KEY,
    concentration_value REAL NOT NULL,   -- 100, 90, 0.5, etc.
    concentration_unit TEXT NOT NULL,     -- "units/mL", "mcg/actuation", "mg/mL"
    in_use_expiry_days INTEGER,          -- 28 for insulin pens, 30 for some eye drops, null if N/A
    ds_calculation TEXT NOT NULL DEFAULT 'count'
        -- "count"         → tablets/capsules: quantity ÷ per day
        -- "active_units"  → insulin: total units ÷ units per day
        -- "actuations"    → inhalers: total puffs ÷ puffs per day
        -- "volume"        → eye drops: est. drops ÷ drops per day
        -- "manual"        → creams/ointments: tech enters DS directly
);
```

---

## Inventory Storage

Inventory table stores ONE number per NDC — always in base units.

```sql
-- Existing inventory table, quantity is always in base units
-- 45 mL of Lantus, not "3 boxes" or "15 pens"
-- 600 actuations of albuterol, not "3 inhalers"
-- 500 tablets of lisinopril, not "5 bottles"
```

### Receiving inventory

Tech receives 2 boxes of Lantus:
```
lookup: "box" for form "pen" → base_equivalent = 15
inventory += 2 × 15 = +30 base units (mL)
```

### Dispensing

Tech fills 1 box of Lantus:
```
lookup: "box" for form "pen" → base_equivalent = 15
inventory -= 1 × 15 = -15 base units (mL)
```

### Display

```
on_hand_base = 45 (mL)

Units for this form:
  box: 15 mL → 45 ÷ 15 = 3 boxes
  pen: 3 mL  → 45 ÷ 3  = 15 pens
  mL:  1 mL  → 45 ÷ 1  = 45 mL

Display: "3 boxes │ 15 pens │ 45 mL"
```

When there's a remainder:
```
on_hand_base = 48 (mL)

  box: 48 ÷ 15 = 3 boxes + 3 mL remainder
  pen: 48 ÷ 3  = 16 pens
  mL:  48

Display: "3 boxes + 1 pen │ 16 pens │ 48 mL"
```

---

## Resolution Logic (Rust)

```rust
/// Get all unit conversions for a given NDC.
/// Checks product_unit_overrides first, falls back to form_unit_defaults.
fn get_units_for_ndc(ndc: &str, form: &str) -> Vec<UnitConversion> {
    // 1. Load all overrides for this NDC
    let overrides = query("SELECT * FROM product_unit_overrides WHERE ndc = ?", ndc);
    
    // 2. If overrides exist, use them exclusively (full override)
    if !overrides.is_empty() {
        return overrides;
    }
    
    // 3. Otherwise, fall back to form defaults
    let defaults = query("SELECT * FROM form_unit_defaults WHERE form = ?", form);
    return defaults;
}

/// Convert a quantity from one unit to base units
fn to_base_units(quantity: f64, unit_name: &str, units: &[UnitConversion]) -> f64 {
    let unit = units.iter().find(|u| u.unit_name == unit_name).unwrap();
    quantity * unit.base_equivalent
}

/// Convert base units to display units (returns whole units + remainder in base)
fn from_base_units(base_qty: f64, unit_name: &str, units: &[UnitConversion]) -> (i64, f64) {
    let unit = units.iter().find(|u| u.unit_name == unit_name).unwrap();
    let whole = (base_qty / unit.base_equivalent).floor() as i64;
    let remainder = base_qty - (whole as f64 * unit.base_equivalent);
    (whole, remainder)
}

/// Get full display string for inventory: "3 boxes │ 15 pens │ 45 mL"
fn display_inventory(base_qty: f64, units: &[UnitConversion]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut sorted = units.to_vec();
    sorted.sort_by_key(|u| u.display_order);
    
    for unit in &sorted {
        let (whole, _remainder) = from_base_units(base_qty, &unit.unit_name, units);
        if whole > 0 || unit.is_base {
            parts.push(format!("{} {}", whole, unit.unit_name));
        }
    }
    parts.join(" │ ")
}
```

---

## Days Supply Calculator

Uses `product_concentration` + unit conversions + sig parsing.

```rust
fn calculate_days_supply(
    ndc: &str,
    form: &str,
    quantity_dispensed: f64,      // In dispensable units (e.g., 1 box)
    dispensed_unit: &str,         // "box"
    daily_dose: f64,             // From sig parsing: 20 units, 2 puffs, 1 tablet
    daily_dose_unit: &str,       // "units", "actuations", "each"
) -> DaysSupplyResult {
    let units = get_units_for_ndc(ndc, form);
    let conc = get_concentration(ndc);
    
    match conc.ds_calculation.as_str() {
        "count" => {
            // Tablets/capsules: simple division
            // 30 tablets ÷ 1 per day = 30 days
            let base_qty = to_base_units(quantity_dispensed, dispensed_unit, &units);
            DaysSupplyResult {
                days: (base_qty / daily_dose).floor() as i32,
                method: "count",
                calculation: format!("{} {} ÷ {} per day", base_qty, "each", daily_dose),
            }
        },
        "active_units" => {
            // Insulin, concentrated liquids
            // 1 box = 15 mL × 100 units/mL = 1500 units ÷ 20 units/day = 75 days
            let base_qty = to_base_units(quantity_dispensed, dispensed_unit, &units);
            let total_active = base_qty * conc.concentration_value;
            DaysSupplyResult {
                days: (total_active / daily_dose).floor() as i32,
                method: "active_units",
                calculation: format!(
                    "{} {} × {} {} = {} {} ÷ {} per day",
                    base_qty, units[0].unit_name,  // base unit name
                    conc.concentration_value, conc.concentration_unit,
                    total_active, "units",
                    daily_dose
                ),
            }
        },
        "actuations" => {
            // Inhalers
            // 1 inhaler = 200 actuations ÷ 4 puffs/day = 50 days
            let base_qty = to_base_units(quantity_dispensed, dispensed_unit, &units);
            DaysSupplyResult {
                days: (base_qty / daily_dose).floor() as i32,
                method: "actuations",
                calculation: format!("{} actuations ÷ {} per day", base_qty, daily_dose),
            }
        },
        "volume" => {
            // Eye drops: estimate drops from volume
            // 5 mL × ~20 drops/mL = ~100 drops ÷ 4 drops/day = 25 days
            let base_qty = to_base_units(quantity_dispensed, dispensed_unit, &units);
            let est_drops = base_qty * 20.0; // ~20 drops per mL is standard estimate
            DaysSupplyResult {
                days: (est_drops / daily_dose).floor() as i32,
                method: "volume_estimated",
                calculation: format!(
                    "{} mL × ~20 drops/mL ≈ {} drops ÷ {} per day",
                    base_qty, est_drops, daily_dose
                ),
            }
        },
        "manual" | _ => {
            // Creams, ointments, misc: tech enters directly
            DaysSupplyResult {
                days: 0, // Must be entered manually
                method: "manual",
                calculation: "Manual entry required — dosage form does not support auto-calculation".into(),
            }
        },
    }
}
```

### Key Design Decision: Show the Math

The `calculation` string is displayed to the tech in the fill panel. They see *how* the system arrived at the days supply, not just the number. If it's wrong, they can override it — but they know why it was what it was.

```
Days Supply: 75
  ℹ 15 mL × 100 units/mL = 1500 units ÷ 20 units per day
  [Override ▾]
```

This is educational and protective. The tech learns the math. The pharmacist sees the reasoning during verification.

---

## In-Use Expiry

Some products have a shorter shelf life once opened/first used:

- Insulin pens: 28 days after first injection
- Some eye drops: 28-30 days after opening
- Reconstituted suspensions: 10-14 days after mixing

The `in_use_expiry_days` field enables a warning: if the calculated days supply exceeds the in-use expiry, the system flags it.

```
⚠ Days supply (75 days) exceeds in-use expiry (28 days).
  Patient will need multiple pens opened over this period.
```

This doesn't block — it informs. The pharmacist might counsel the patient on pen storage, or the tech might note that the patient actually needs to start a new pen monthly.

---

## Seed Data — Form-Level Defaults

These cover the most common dosage forms. Preloaded on install.

### Oral Solids

```sql
-- Tablets & Capsules
INSERT INTO form_unit_defaults (form, unit_name, base_equivalent, is_base, is_dispensable, is_billing, display_order) VALUES
('tablet',  'each',   1,    1, 0, 0, 2),
('tablet',  'bottle', 30,   0, 0, 0, 3),  -- Default bottle; overridden per NDC if 60, 90, 100, etc.
('tablet',  'qty',    1,    0, 1, 1, 1),   -- Dispensed/billed as counted quantity
('capsule', 'each',   1,    1, 0, 0, 2),
('capsule', 'bottle', 30,   0, 0, 0, 3),
('capsule', 'qty',    1,    0, 1, 1, 1);

-- DS calculation: "count"
INSERT INTO product_concentration (ndc, concentration_value, concentration_unit, ds_calculation)
VALUES ('FORM_DEFAULT:tablet', 1, 'each', 'count');
INSERT INTO product_concentration (ndc, concentration_value, concentration_unit, ds_calculation)
VALUES ('FORM_DEFAULT:capsule', 1, 'each', 'count');
```

### Insulin Pens

```sql
-- Standard insulin pen: 3mL per pen, 5 pens per box
INSERT INTO form_unit_defaults VALUES
('insulin_pen', 'mL',  1,    1, 0, 1, 3),   -- Base unit, billing unit
('insulin_pen', 'pen', 3,    0, 0, 0, 2),
('insulin_pen', 'box', 15,   0, 1, 0, 1);   -- Dispensable unit

-- Common concentrations (NDC-level):
-- Lantus/Basaglar/Semglee:    100 units/mL, 28-day in-use
-- Humalog/Novolog:            100 units/mL, 28-day in-use
-- Tresiba:                    200 units/mL, 56-day in-use (U-200)
-- Toujeo:                     300 units/mL, 42-day in-use (U-300, 1.5mL pen)
-- Ozempic:                    not insulin but same pen form, mg/mL dosing
```

### Insulin Vials

```sql
-- Standard insulin vial: 10mL
INSERT INTO form_unit_defaults VALUES
('insulin_vial', 'mL',   1,    1, 0, 1, 2),  -- Base + billing
('insulin_vial', 'vial', 10,   0, 1, 0, 1);  -- Dispensable

-- Most are 100 units/mL, 28-day in-use after first puncture
```

### Metered-Dose Inhalers (MDI)

```sql
-- Standard MDI: counted by actuations
INSERT INTO form_unit_defaults VALUES
('inhaler_mdi', 'actuation', 1,    1, 0, 0, 3),  -- Base unit
('inhaler_mdi', 'inhaler',   200,  0, 1, 1, 1),  -- Dispensable + billing
('inhaler_mdi', 'g',         8.5,  0, 0, 0, 2);  -- Net weight (approximate, varies)

-- Common actuation counts (NDC-level overrides):
-- Albuterol HFA (ProAir/Ventolin/Proventil): 200 actuations
-- Flovent HFA: 120 actuations
-- Advair HFA: 120 actuations
-- Symbicort: 120 actuations (60 or 120 depending on NDC)
-- Atrovent HFA: 200 actuations
-- Combivent Respimat: 120 actuations (soft mist, different form)
```

### Dry Powder Inhalers (DPI)

```sql
-- Diskus, Ellipta, etc: counted by doses (blisters)
INSERT INTO form_unit_defaults VALUES
('inhaler_dpi', 'dose',    1,    1, 0, 0, 2),   -- Base unit
('inhaler_dpi', 'inhaler', 30,   0, 1, 1, 1);   -- 30-dose is most common, override per NDC

-- Common dose counts:
-- Advair Diskus: 60 doses
-- Breo Ellipta: 30 doses
-- Wixela Inhub: 60 doses
-- Spiriva HandiHaler: 30 capsules (technically separate caps but same concept)
```

### Soft Mist Inhalers

```sql
-- Respimat devices
INSERT INTO form_unit_defaults VALUES
('inhaler_smi', 'actuation', 1,    1, 0, 0, 2),
('inhaler_smi', 'inhaler',   120,  0, 1, 1, 1);  -- Typically 60 doses × 2 puffs = 120 actuations

-- Spiriva Respimat: 60 doses (2 puffs/dose = 120 actuations per cartridge)
-- Combivent Respimat: 120 actuations
```

### Nebulizer Solutions

```sql
-- Single-dose vials (most common for neb solutions)
INSERT INTO form_unit_defaults VALUES
('nebulizer', 'mL',   1,    1, 0, 0, 3),  -- Base unit
('nebulizer', 'vial', 3,    0, 0, 0, 2),  -- Typical 2.5mL or 3mL unit dose vials
('nebulizer', 'box',  75,   0, 1, 1, 1);  -- 25 vials × 3mL typical box

-- Override per NDC — vial sizes vary:
-- Albuterol neb: 2.5mL vials, boxes of 25 or 60
-- Budesonide neb: 2mL vials, boxes of 30
-- Ipratropium neb: 2.5mL vials, boxes of 25 or 60
```

### Eye Drops

```sql
-- Standard ophthalmic solution
INSERT INTO form_unit_defaults VALUES
('eye_drops', 'drop',   1,      1, 0, 0, 3),  -- Base unit (estimated)
('eye_drops', 'mL',     20,     0, 0, 1, 2),  -- ~20 drops per mL (standard estimate), billing
('eye_drops', 'bottle', 100,    0, 1, 0, 1);  -- 5mL bottle = ~100 drops, dispensable

-- Common bottle sizes (NDC-level overrides):
-- Latanoprost: 2.5mL bottle → 50 drops → base_equivalent = 50
-- Timolol: 5mL, 10mL, 15mL
-- Prednisolone: 5mL, 10mL
-- Restasis: 0.4mL single-use vials, box of 30 → completely different structure
```

### Ear Drops

```sql
INSERT INTO form_unit_defaults VALUES
('ear_drops', 'drop',   1,     1, 0, 0, 3),
('ear_drops', 'mL',     20,    0, 0, 1, 2),
('ear_drops', 'bottle', 200,   0, 1, 0, 1);  -- 10mL typical

-- DS calculation: "volume" (same drop estimation as eye drops)
```

### Nasal Sprays

```sql
INSERT INTO form_unit_defaults VALUES
('nasal_spray', 'spray',  1,     1, 0, 0, 3),  -- Base unit
('nasal_spray', 'bottle', 120,   0, 1, 1, 1);  -- 120 sprays typical

-- Common spray counts:
-- Flonase/Fluticasone: 120 sprays per bottle
-- Nasonex: 120 sprays
-- Azelastine: 200 sprays
-- Ipratropium nasal: 345 sprays (0.06%) or 260 sprays (0.03%)
```

### Topical Creams / Ointments / Gels

```sql
INSERT INTO form_unit_defaults VALUES
('cream',    'g',    1,    1, 1, 1, 1),  -- Base = dispensable = billing (all grams)
('ointment', 'g',    1,    1, 1, 1, 1),
('gel',      'g',    1,    1, 1, 1, 1);

-- Common tube sizes: 15g, 30g, 45g, 60g — these are NDC-level, not form-level
-- No standard tube-to-gram conversion because tubes come in many sizes
-- DS calculation: "manual" — no way to auto-calculate without knowing surface area
```

### Oral Liquids / Suspensions

```sql
INSERT INTO form_unit_defaults VALUES
('oral_liquid', 'mL',     1,     1, 0, 1, 2),  -- Base + billing
('oral_liquid', 'bottle', 100,   0, 1, 0, 1);  -- 100mL common, override per NDC

-- Common sizes:
-- Amoxicillin suspension: 100mL, 150mL bottles
-- Azithromycin suspension: 15mL, 22.5mL, 30mL (single-dose packs)
-- Prednisone liquid: 120mL
-- DS calculation: "volume" but based on mL/dose not drops
```

### Patches

```sql
INSERT INTO form_unit_defaults VALUES
('patch', 'each', 1,    1, 0, 0, 2),  -- Base unit
('patch', 'box',  30,   0, 1, 1, 1);  -- 30 patches typical box

-- Wear schedule varies:
-- Fentanyl: change every 72 hours → 10 patches = 30 days
-- Lidocaine: 12 hours on, 12 off → 30 patches = 30 days
-- Estradiol: change twice weekly → ~8 patches = 28 days
-- Nicotine: daily → 14 or 28 patches per box
-- NDC-level override needed for box size + wear schedule affects DS
```

### Suppositories

```sql
INSERT INTO form_unit_defaults VALUES
('suppository', 'each', 1,    1, 0, 0, 2),
('suppository', 'box',  12,   0, 1, 1, 1);  -- 12-count typical

-- DS calculation: "count"
```

### Injectable Vials (Non-Insulin)

```sql
INSERT INTO form_unit_defaults VALUES
('injectable_vial', 'mL',   1,    1, 0, 1, 2),  -- Base + billing
('injectable_vial', 'vial', 1,    0, 1, 0, 1);  -- Override per NDC — vial sizes vary wildly

-- Examples:
-- Testosterone cypionate: 1mL vial (200mg/mL) or 10mL vial
-- B12: 1mL vials, box of 25
-- Humira: 0.8mL or 0.4mL prefilled syringe
-- Enbrel: 1mL prefilled syringe or SureClick autoinjector
-- DS calculation: "active_units" — total mg or mcg ÷ dose per injection × injection frequency
```

### Prefilled Syringes / Autoinjectors

```sql
INSERT INTO form_unit_defaults VALUES
('prefilled_syringe', 'mL',      1,    1, 0, 0, 3),
('prefilled_syringe', 'syringe', 1,    0, 0, 0, 2),  -- Override volume per NDC
('prefilled_syringe', 'box',     4,    0, 1, 1, 1);   -- Typical 4-pack, override per NDC

-- Humira: 2 syringes/box (every 2 weeks = 28 days)
-- Enbrel: 4 syringes/box (weekly = 28 days)
-- Ozempic pen: technically a pen but multi-dose, different from insulin pens
-- DS heavily dependent on injection frequency
```

---

## Rust Commands

```rust
#[tauri::command]
fn get_product_units(ndc: String, form: String) -> Vec<UnitConversion>
// Resolution: check overrides first, fall back to form defaults

#[tauri::command]
fn get_product_concentration(ndc: String) -> Option<ProductConcentration>

#[tauri::command]
fn convert_units(ndc: String, form: String, quantity: f64, from_unit: String, to_unit: String) -> f64
// General purpose converter

#[tauri::command]
fn calculate_days_supply(
    ndc: String,
    form: String,
    quantity: f64,
    dispensed_unit: String,
    daily_dose: f64,
    daily_dose_unit: String
) -> DaysSupplyResult

#[tauri::command]
fn display_inventory_units(ndc: String, form: String, base_quantity: f64) -> Vec<UnitDisplay>
// Returns: [{ unit: "box", quantity: 3 }, { unit: "pen", quantity: 15 }, { unit: "mL", quantity: 45 }]

#[tauri::command]
fn set_product_override(ndc: String, units: Vec<UnitConversion>) -> ()
// Pharmacy-level customization

#[tauri::command]
fn get_common_forms() -> Vec<String>
// Returns list of all form types with defaults configured
```

---

## Frontend Display

### Inventory Panel

```
┌─────────────────────────────────────────────┐
│ Lantus Solostar 100 units/mL                │
│ NDC: 00088-2220-05                          │
│                                             │
│ On hand:  3 boxes │ 15 pens │ 45 mL         │
│                                             │
│ [Receive ▾]  [Adjust ▾]                     │
└─────────────────────────────────────────────┘
```

### Fill Panel — Days Supply

```
┌─────────────────────────────────────────────┐
│ Quantity: 1 box  (= 15 pens = 45 mL)       │
│                                             │
│ Sig: Inject 20 units subcut daily           │
│                                             │
│ Days Supply: 75                             │
│   ℹ  15 mL × 100 units/mL = 1500 units     │
│      1500 units ÷ 20 units/day = 75 days    │
│                                             │
│   ⚠ Exceeds 28-day in-use expiry.           │
│     Patient will open multiple pens.        │
│                                             │
│ [Override DS ▾]                             │
└─────────────────────────────────────────────┘
```

### Fill Panel — Manual DS (Creams)

```
┌─────────────────────────────────────────────┐
│ Quantity: 1 tube  (= 45 g)                  │
│                                             │
│ Sig: Apply to affected area BID             │
│                                             │
│ Days Supply: [____]                         │
│   ℹ  Auto-calculation not available for     │
│      topical creams. Enter days supply      │
│      based on clinical judgment.            │
└─────────────────────────────────────────────┘
```

---

## Migration / Seeding Strategy

1. Schema migration (next `PRAGMA user_version` bump) creates both tables + `product_concentration`
2. Seed SQL file runs on first migration — populates all `form_unit_defaults` from the data above
3. `product_unit_overrides` starts empty — populated as pharmacy encounters specific NDCs that deviate
4. `product_concentration` populated per-NDC as products are added to inventory
5. Prompt tech on first fill of an NDC without concentration data: "No concentration info for this NDC. Enter concentration to enable auto days supply calculation. [100 units/mL ▾]"

---

## What This Enables

- **Inventory accuracy**: One truth, multiple views. No conversion errors.
- **Days supply automation**: System does the math for 90%+ of products. Shows its work.
- **New tech education**: Seeing "3 boxes = 15 pens = 45 mL" every time teaches the relationships.
- **Insurance billing**: Billing unit is flagged per form — system knows what number to submit.
- **In-use expiry warnings**: Catches the "75 days supply but pen expires in 28 days" problem.
- **Clinical traps for the study**: Generate a Lantus Rx with quantity 2 boxes and sig "inject 10 units daily" — DS = 300 days. No pharmacist should approve that without questioning.
- **Extensible**: New dosage forms = new rows in `form_unit_defaults`. No code changes.
