# NDC Search — Implementation Instructions for Claude Code

## STOP. READ THIS FIRST.

Before writing ANY code, you MUST do the following:

1. Open `drug_tree.db` in SQLite
2. Run `.schema` to see every table and column
3. Run `SELECT * FROM <each_table> LIMIT 5` to see actual data
4. Find which column(s) contain NDC values
5. Look at the EXACT FORMAT of the NDC strings stored in the database

Do NOT guess. Do NOT assume. LOOK at the actual data.

---

## The Problem With NDC Search

NDCs (National Drug Codes) come in multiple formats. The same product can be represented as:

```
11-digit:    00069-1530-30
10-digit:    0069-1530-30
plain:       00069153030
FDA format:  0069-153-030  (5-3-2 segments, no zero-padding)
```

The database stores NDCs in ONE specific format. Your search input might come in ANY format. If you do a naive `WHERE ndc = ?` and the formats don't match, you get zero results even though the drug exists.

---

## Step 1: Discover the Database Format

Run these queries and PASTE THE OUTPUT into your working notes before writing code:

```sql
-- What tables exist?
.tables

-- What's the schema?
.schema

-- Find columns that might contain NDCs
-- (look for columns named ndc, NDC, ndc_code, product_ndc, package_ndc, etc.)

-- Sample actual NDC values (run for EACH table that has an NDC column)
SELECT DISTINCT <ndc_column> FROM <table> LIMIT 20;
```

**Critical questions to answer:**
- Is the NDC stored WITH dashes (00069-1530-30) or WITHOUT (00069153030)?
- Is it 10-digit or 11-digit?
- Is it in the 5-4-2, 4-4-2, or 5-3-2 segment format?
- Are there leading zeros?
- Is the NDC in ONE table or split across multiple tables (e.g., a products table and a packages table)?

---

## Step 2: Build a Normalizer

Whatever format the DB uses, build a normalizer that converts ANY input format to the DB's format.

```rust
/// Strip all non-alphanumeric characters and normalize to the database's format
fn normalize_ndc(input: &str) -> String {
    // Step 1: Remove dashes, spaces, any non-digit characters
    let digits_only: String = input.chars().filter(|c| c.is_ascii_digit()).collect();
    
    // Step 2: Pad to 11 digits if needed (NDCs are 10 or 11 digits)
    // The 11-digit format zero-pads the first segment
    let padded = if digits_only.len() == 10 {
        format!("0{}", digits_only)  // Pad to 11
    } else {
        digits_only
    };
    
    // Step 3: Format to match whatever the database stores
    // ===========================================================
    // THIS IS THE PART YOU MUST CUSTOMIZE BASED ON STEP 1 RESULTS
    // ===========================================================
    //
    // If DB stores "00069-1530-30" (5-4-2 with dashes):
    //   format!("{}-{}-{}", &padded[0..5], &padded[5..9], &padded[9..11])
    //
    // If DB stores "00069153030" (plain 11-digit):
    //   padded  (already done)
    //
    // If DB stores "0069-1530-30" (4-4-2 with dashes, 10-digit):
    //   let ten = &padded[1..];  // strip leading zero
    //   format!("{}-{}-{}", &ten[0..4], &ten[4..8], &ten[8..10])
    //
    // If DB stores "0069-153-030" (FDA 4-3-3 or similar):
    //   You need to figure out the exact segment pattern from the data
    
    padded // REPLACE THIS with the correct format
}
```

---

## Step 3: The Search Command

```rust
#[tauri::command]
fn search_drug_by_ndc(ndc_input: String) -> Result<Vec<DrugResult>, String> {
    let db = get_drug_tree_db()?;
    let normalized = normalize_ndc(&ndc_input);
    
    // ALSO try a LIKE search in case of partial NDC entry
    // (tech might scan a barcode that gives a partial, or type first few digits)
    let like_pattern = format!("{}%", normalized);
    
    let mut stmt = db.prepare(
        // =======================================================
        // REPLACE THIS QUERY WITH THE ACTUAL TABLE AND COLUMN NAMES
        // FROM YOUR STEP 1 INVESTIGATION
        // =======================================================
        "SELECT <columns> FROM <table> 
         WHERE <ndc_column> = ?1 
         OR <ndc_column> LIKE ?2
         LIMIT 20"
    ).map_err(|e| e.to_string())?;
    
    let results = stmt.query_map(params![&normalized, &like_pattern], |row| {
        // Map to your result struct
        Ok(DrugResult {
            // Fill in based on actual columns
        })
    }).map_err(|e| e.to_string())?;
    
    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
```

---

## Step 4: Test It

Before declaring success, test with ALL these input formats for the SAME drug:

```rust
// All of these should return the same result:
search_drug_by_ndc("00069-1530-30")  // 5-4-2 with dashes
search_drug_by_ndc("0069-1530-30")   // 4-4-2 with dashes  
search_drug_by_ndc("00069153030")    // plain 11-digit
search_drug_by_ndc("0069153030")     // plain 10-digit
search_drug_by_ndc("69153030")       // no leading zeros at all
```

If ANY of these fail to find the drug, your normalizer is wrong. Fix it.

---

## Step 5: Barcode Scanner Input

Real barcode scanners on pharmacy bottles output NDCs in various ways:

- Some prepend "0" to make it 11 digits
- Some output raw 10-digit
- Some include the "3" prefix for UPC-A format (strip it)
- Some output just digits, some include dashes

Your normalizer must handle ALL of these. The key rule: **strip everything that isn't a digit, pad to 11 digits, format to match the DB.**

If the input starts with "3" and is 12 digits, it's likely a UPC-A barcode. Strip the leading "3" and the trailing check digit to get the 10-digit NDC:

```rust
fn normalize_ndc(input: &str) -> String {
    let digits_only: String = input.chars().filter(|c| c.is_ascii_digit()).collect();
    
    // Handle UPC-A barcode format (12 digits starting with 3)
    let ndc_digits = if digits_only.len() == 12 && digits_only.starts_with('3') {
        // Strip leading "3" and trailing check digit
        digits_only[1..11].to_string()
    } else {
        digits_only
    };
    
    // Pad to 11 digits
    let padded = match ndc_digits.len() {
        10 => format!("0{}", ndc_digits),
        11 => ndc_digits,
        _ => ndc_digits, // Partial input, don't pad
    };
    
    // Format to match DB storage (CUSTOMIZE THIS)
    padded
}
```

---

## Common Mistakes to AVOID

1. **Don't assume the NDC column is called "ndc"** — it might be `product_ndc`, `package_ndc`, `NDC`, `ndc_code`, or something else entirely. LOOK AT THE SCHEMA.

2. **Don't assume one table** — drug_tree databases often have a hierarchy: products table → packages table. The NDC might be on the packages table while the drug name is on the products table. You may need a JOIN.

3. **Don't hardcode the format** — discover it from the data FIRST, then write the normalizer to match.

4. **Don't forget COLLATE NOCASE** — if the DB stores letters in NDCs (rare but possible), make the comparison case-insensitive.

5. **Don't return raw database rows** — format the result into a clean struct with: drug name, strength, form, NDC, manufacturer, package size. The frontend needs all of these.

6. **Don't skip the LIKE fallback** — exact match should be tried first, but if the tech types a partial NDC or the format is slightly off, LIKE catches it.

---

## Checklist Before You're Done

- [ ] I ran `.schema` and `.tables` on drug_tree.db
- [ ] I found the NDC column(s) and noted the exact format
- [ ] I sampled 20+ NDC values to confirm the format is consistent
- [ ] My normalizer converts any input format to the DB's format
- [ ] I tested with dashed, undashed, 10-digit, and 11-digit inputs
- [ ] All formats return the same drug
- [ ] Partial NDC input returns results (LIKE search)
- [ ] The command is registered in lib.rs
- [ ] The frontend can call it through TauriDataProvider
