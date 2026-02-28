import { useState, useCallback, useRef, useEffect, createContext, useContext, useMemo, useReducer } from "react";
import { createTauriDataProvider } from './TauriDataProvider';
import InventoryWorkspace from './InventoryWorkspace';

// ============================================================
// DARK THEME
// ============================================================
const T = {
  // Surfaces
  bg: "#13151a",           // app background
  surface: "#1a1d24",      // panels, cards
  surfaceRaised: "#21242d", // elevated surfaces (tile content)
  surfaceBorder: "#2a2e38", // borders between surfaces
  surfaceHover: "#262a35",  // hover states

  // Tile chrome
  tileBg: "#1e2129",       // tile background
  tileBorder: "#2a2e38",   // tile border
  tileHeaderBg: "#1a1d24", // tile title bar (tinted by workspace color)

  // Text
  textPrimary: "#e2e8f0",  // main text
  textSecondary: "#8b95a8", // secondary / labels
  textMuted: "#5a6475",     // disabled / placeholder
  textAccent: "#94a3b8",    // subtle emphasis

  // Input fields
  inputBg: "#1a1d24",
  inputBorder: "#2e3340",
  inputFocusBorder: "#4a5568",
  inputText: "#e2e8f0",

  // Queue bar
  queueBg: "#111318",
  queueBorder: "#1e2129",

  // Shared
  radius: 12,              // default border radius
  radiusSm: 8,             // smaller elements
  radiusXs: 6,             // buttons, inputs

  // Font
  sans: "'Inter', 'IBM Plex Sans', -apple-system, sans-serif",
  mono: "'IBM Plex Mono', 'SF Mono', monospace",
  sizeBase: 13,
  sizeSm: 11,
  sizeXs: 10,
};
// DATA PROVIDER INTERFACE
// ============================================================
// This is the contract. Everything that supplies data to PharmIDE
// implements this interface. Right now it's mock-backed.
// Swap in PharmSim API, REST, local DB — the form doesn't care.

const DataProviderContext = createContext(null);

function useDataProvider() {
  const ctx = useContext(DataProviderContext);
  if (!ctx) throw new Error("useDataProvider must be used within DataProviderContext");
  return ctx;
}

// ── Mock Drug Database ──────────────────────────────────────
const DRUG_DATABASE = [
  {
    id: "d001", name: "lisinopril", brandNames: ["Zestril", "Prinivil"],
    strengths: ["2.5mg", "5mg", "10mg", "20mg", "40mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "ACE Inhibitor",
    maxDaily: "80mg", commonDoses: ["10mg daily", "20mg daily"],
    ndcByStrength: { "2.5mg": "68180-0513-01", "5mg": "68180-0514-01", "10mg": "68180-0515-01", "20mg": "68180-0516-01", "40mg": "68180-0517-01" },
  },
  {
    id: "d002", name: "metformin", brandNames: ["Glucophage"],
    strengths: ["500mg", "850mg", "1000mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "Biguanide",
    maxDaily: "2550mg", commonDoses: ["500mg BID", "1000mg BID"],
    ndcByStrength: { "500mg": "00228-2775-11", "850mg": "00228-2776-11", "1000mg": "00228-2791-11" },
  },
  {
    id: "d003", name: "atorvastatin", brandNames: ["Lipitor"],
    strengths: ["10mg", "20mg", "40mg", "80mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "HMG-CoA Reductase Inhibitor",
    maxDaily: "80mg", commonDoses: ["20mg daily", "40mg daily"],
    ndcByStrength: { "10mg": "00071-0155-23", "20mg": "00071-0156-23", "40mg": "00071-0157-23", "80mg": "00071-0158-23" },
  },
  {
    id: "d004", name: "amlodipine", brandNames: ["Norvasc"],
    strengths: ["2.5mg", "5mg", "10mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "Calcium Channel Blocker",
    maxDaily: "10mg", commonDoses: ["5mg daily", "10mg daily"],
    ndcByStrength: { "2.5mg": "00069-1520-30", "5mg": "00069-1530-30", "10mg": "00069-1540-30" },
  },
  {
    id: "d005", name: "escitalopram", brandNames: ["Lexapro"],
    strengths: ["5mg", "10mg", "20mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "SSRI",
    maxDaily: "20mg", commonDoses: ["10mg daily", "20mg daily"],
    ndcByStrength: { "5mg": "00456-2005-01", "10mg": "00456-2010-01", "20mg": "00456-2020-01" },
  },
  {
    id: "d006", name: "omeprazole", brandNames: ["Prilosec"],
    strengths: ["10mg", "20mg", "40mg"], form: "capsule",
    route: "oral", schedule: "Rx", drugClass: "Proton Pump Inhibitor",
    maxDaily: "40mg", commonDoses: ["20mg daily", "40mg BID"],
    ndcByStrength: { "10mg": "00186-5010-31", "20mg": "00186-5020-31", "40mg": "00186-5040-31" },
  },
  {
    id: "d007", name: "gabapentin", brandNames: ["Neurontin"],
    strengths: ["100mg", "300mg", "400mg", "600mg", "800mg"], form: "capsule",
    route: "oral", schedule: "Rx", drugClass: "Anticonvulsant",
    maxDaily: "3600mg", commonDoses: ["300mg TID", "600mg TID"],
    ndcByStrength: { "100mg": "00071-0803-24", "300mg": "00071-0805-24", "400mg": "00071-0806-24", "600mg": "00071-0807-24", "800mg": "00071-0808-24" },
  },
  {
    id: "d008", name: "metoprolol succinate", brandNames: ["Toprol-XL"],
    strengths: ["25mg", "50mg", "100mg", "200mg"], form: "tablet, extended release",
    route: "oral", schedule: "Rx", drugClass: "Beta Blocker",
    maxDaily: "400mg", commonDoses: ["25mg daily", "50mg daily"],
    ndcByStrength: { "25mg": "00186-1088-05", "50mg": "00186-1092-05", "100mg": "00186-1096-05", "200mg": "00186-1097-05" },
  },
  {
    id: "d009", name: "levothyroxine", brandNames: ["Synthroid", "Levoxyl"],
    strengths: ["25mcg", "50mcg", "75mcg", "88mcg", "100mcg", "112mcg", "125mcg", "150mcg", "200mcg"],
    form: "tablet", route: "oral", schedule: "Rx", drugClass: "Thyroid Hormone",
    maxDaily: "300mcg", commonDoses: ["50mcg daily", "100mcg daily"],
    ndcByStrength: { "25mcg": "00074-6624-90", "50mcg": "00074-6625-90", "75mcg": "00074-6627-90", "88mcg": "00074-6628-90", "100mcg": "00074-6629-90", "112mcg": "00074-6630-90", "125mcg": "00074-6631-90", "150mcg": "00074-6633-90", "200mcg": "00074-6636-90" },
  },
  {
    id: "d010", name: "montelukast", brandNames: ["Singulair"],
    strengths: ["4mg", "5mg", "10mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "Leukotriene Receptor Antagonist",
    maxDaily: "10mg", commonDoses: ["10mg daily at bedtime"],
    ndcByStrength: { "4mg": "00006-0711-31", "5mg": "00006-0275-31", "10mg": "00006-0117-31" },
  },
  {
    id: "d011", name: "oxycodone", brandNames: ["OxyContin", "Roxicodone"],
    strengths: ["5mg", "10mg", "15mg", "20mg", "30mg"], form: "tablet",
    route: "oral", schedule: "C-II", drugClass: "Opioid Analgesic",
    maxDaily: null, commonDoses: ["5mg q4-6h PRN"],
    ndcByStrength: { "5mg": "59011-0410-10", "10mg": "59011-0420-10", "15mg": "59011-0430-10", "20mg": "59011-0440-10", "30mg": "59011-0450-10" },
  },
  {
    id: "d012", name: "alprazolam", brandNames: ["Xanax"],
    strengths: ["0.25mg", "0.5mg", "1mg", "2mg"], form: "tablet",
    route: "oral", schedule: "C-IV", drugClass: "Benzodiazepine",
    maxDaily: "4mg", commonDoses: ["0.25mg TID PRN", "0.5mg TID PRN"],
    ndcByStrength: { "0.25mg": "00009-0029-01", "0.5mg": "00009-0055-01", "1mg": "00009-0090-01", "2mg": "00009-0094-01" },
  },
  {
    id: "d013", name: "hydrocodone/acetaminophen", brandNames: ["Norco", "Vicodin"],
    strengths: ["5/325mg", "7.5/325mg", "10/325mg"], form: "tablet",
    route: "oral", schedule: "C-II", drugClass: "Opioid Analgesic Combination",
    maxDaily: "6 tablets (10/325)", commonDoses: ["1 tab q4-6h PRN"],
    ndcByStrength: { "5/325mg": "52544-0161-01", "7.5/325mg": "52544-0162-01", "10/325mg": "52544-0163-01" },
  },
  {
    id: "d014", name: "tramadol", brandNames: ["Ultram"],
    strengths: ["50mg", "100mg"], form: "tablet",
    route: "oral", schedule: "C-IV", drugClass: "Opioid Analgesic",
    maxDaily: "400mg", commonDoses: ["50mg q4-6h PRN"],
    ndcByStrength: { "50mg": "00045-0659-60", "100mg": "00045-0660-60" },
  },
  {
    id: "d015", name: "amoxicillin", brandNames: ["Amoxil"],
    strengths: ["250mg", "500mg", "875mg"], form: "capsule",
    route: "oral", schedule: "Rx", drugClass: "Penicillin Antibiotic",
    maxDaily: "3000mg", commonDoses: ["500mg TID", "875mg BID"],
    ndcByStrength: { "250mg": "65862-0001-01", "500mg": "65862-0002-01", "875mg": "65862-0003-01" },
  },
  {
    id: "d016", name: "azithromycin", brandNames: ["Zithromax", "Z-Pack"],
    strengths: ["250mg", "500mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "Macrolide Antibiotic",
    maxDaily: "500mg", commonDoses: ["500mg day 1, then 250mg x4 days"],
    ndcByStrength: { "250mg": "00069-3060-75", "500mg": "00069-3070-30" },
  },
  {
    id: "d017", name: "prednisone", brandNames: ["Deltasone"],
    strengths: ["1mg", "2.5mg", "5mg", "10mg", "20mg", "50mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "Corticosteroid",
    maxDaily: null, commonDoses: ["10mg daily", "20mg taper"],
    ndcByStrength: { "1mg": "00054-4741-25", "2.5mg": "00054-4742-25", "5mg": "00054-4728-25", "10mg": "00054-4729-25", "20mg": "00054-4730-25", "50mg": "00054-4731-25" },
  },
  {
    id: "d018", name: "fluoxetine", brandNames: ["Prozac"],
    strengths: ["10mg", "20mg", "40mg", "60mg"], form: "capsule",
    route: "oral", schedule: "Rx", drugClass: "SSRI",
    maxDaily: "80mg", commonDoses: ["20mg daily", "40mg daily"],
    ndcByStrength: { "10mg": "00777-3105-02", "20mg": "00777-3106-02", "40mg": "00777-3107-02", "60mg": "00777-3108-02" },
  },
];

// ── Mock Product Database (specific dispensable products) ────
// Each product links to a drug concept and represents a specific
// manufacturer + strength + form + pack size with its own NDC.
const PRODUCT_DATABASE = [
  // ── Lisinopril products ──
  { id: "pr001", drugId: "d001", ndc: "68180-0514-01", strength: "5mg", form: "tablet", manufacturer: "Lupin", packSize: 100, packUnit: "EA", description: "Lisinopril 5mg Tab (Lupin) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr002", drugId: "d001", ndc: "68180-0515-01", strength: "10mg", form: "tablet", manufacturer: "Lupin", packSize: 100, packUnit: "EA", description: "Lisinopril 10mg Tab (Lupin) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr003", drugId: "d001", ndc: "68180-0516-01", strength: "20mg", form: "tablet", manufacturer: "Lupin", packSize: 100, packUnit: "EA", description: "Lisinopril 20mg Tab (Lupin) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr004", drugId: "d001", ndc: "00071-0207-23", strength: "10mg", form: "tablet", manufacturer: "Merck (Prinivil)", packSize: 90, packUnit: "EA", description: "Prinivil 10mg Tab (Merck) 90ct", isGeneric: false, abRating: "AB" },

  // ── Metformin products ──
  { id: "pr010", drugId: "d002", ndc: "00228-2775-11", strength: "500mg", form: "tablet", manufacturer: "Actavis", packSize: 100, packUnit: "EA", description: "Metformin HCl 500mg Tab (Actavis) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr011", drugId: "d002", ndc: "00228-2791-11", strength: "1000mg", form: "tablet", manufacturer: "Actavis", packSize: 100, packUnit: "EA", description: "Metformin HCl 1000mg Tab (Actavis) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr012", drugId: "d002", ndc: "00087-6060-05", strength: "500mg", form: "tablet", manufacturer: "Novartis (Glucophage)", packSize: 100, packUnit: "EA", description: "Glucophage 500mg Tab (Novartis) 100ct", isGeneric: false, abRating: "AB" },

  // ── Atorvastatin products ──
  { id: "pr020", drugId: "d003", ndc: "00591-3775-01", strength: "10mg", form: "tablet", manufacturer: "Watson", packSize: 90, packUnit: "EA", description: "Atorvastatin 10mg Tab (Watson) 90ct", isGeneric: true, abRating: "AB" },
  { id: "pr021", drugId: "d003", ndc: "00591-3776-01", strength: "20mg", form: "tablet", manufacturer: "Watson", packSize: 90, packUnit: "EA", description: "Atorvastatin 20mg Tab (Watson) 90ct", isGeneric: true, abRating: "AB" },
  { id: "pr022", drugId: "d003", ndc: "00591-3777-01", strength: "40mg", form: "tablet", manufacturer: "Watson", packSize: 90, packUnit: "EA", description: "Atorvastatin 40mg Tab (Watson) 90ct", isGeneric: true, abRating: "AB" },
  { id: "pr023", drugId: "d003", ndc: "00071-0157-23", strength: "40mg", form: "tablet", manufacturer: "Pfizer (Lipitor)", packSize: 90, packUnit: "EA", description: "Lipitor 40mg Tab (Pfizer) 90ct", isGeneric: false, abRating: "AB" },

  // ── Amlodipine products ──
  { id: "pr030", drugId: "d004", ndc: "00069-1530-30", strength: "5mg", form: "tablet", manufacturer: "Pfizer (Norvasc)", packSize: 30, packUnit: "EA", description: "Norvasc 5mg Tab (Pfizer) 30ct", isGeneric: false, abRating: "AB" },
  { id: "pr031", drugId: "d004", ndc: "31722-0702-01", strength: "5mg", form: "tablet", manufacturer: "Camber", packSize: 100, packUnit: "EA", description: "Amlodipine 5mg Tab (Camber) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr032", drugId: "d004", ndc: "31722-0703-01", strength: "10mg", form: "tablet", manufacturer: "Camber", packSize: 100, packUnit: "EA", description: "Amlodipine 10mg Tab (Camber) 100ct", isGeneric: true, abRating: "AB" },

  // ── Escitalopram products ──
  { id: "pr040", drugId: "d005", ndc: "00093-5851-01", strength: "10mg", form: "tablet", manufacturer: "Teva", packSize: 100, packUnit: "EA", description: "Escitalopram 10mg Tab (Teva) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr041", drugId: "d005", ndc: "00093-5852-01", strength: "20mg", form: "tablet", manufacturer: "Teva", packSize: 100, packUnit: "EA", description: "Escitalopram 20mg Tab (Teva) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr042", drugId: "d005", ndc: "00456-2010-30", strength: "10mg", form: "tablet", manufacturer: "Forest (Lexapro)", packSize: 30, packUnit: "EA", description: "Lexapro 10mg Tab (Forest) 30ct", isGeneric: false, abRating: "AB" },
  { id: "pr043", drugId: "d005", ndc: "51991-0747-01", strength: "10mg", form: "tablet", manufacturer: "Cipla", packSize: 100, packUnit: "EA", description: "Escitalopram 10mg Tab (Cipla) 100ct", isGeneric: true, abRating: "AB" },

  // ── Omeprazole products ──
  { id: "pr050", drugId: "d006", ndc: "62175-0450-37", strength: "20mg", form: "capsule", manufacturer: "Mylan", packSize: 100, packUnit: "EA", description: "Omeprazole DR 20mg Cap (Mylan) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr051", drugId: "d006", ndc: "00186-5020-31", strength: "20mg", form: "capsule", manufacturer: "AstraZeneca (Prilosec)", packSize: 30, packUnit: "EA", description: "Prilosec 20mg Cap (AstraZeneca) 30ct", isGeneric: false, abRating: "AB" },

  // ── Gabapentin products ──
  { id: "pr060", drugId: "d007", ndc: "27241-0049-03", strength: "300mg", form: "capsule", manufacturer: "Ascend", packSize: 500, packUnit: "EA", description: "Gabapentin 300mg Cap (Ascend) 500ct", isGeneric: true, abRating: "AB" },
  { id: "pr061", drugId: "d007", ndc: "27241-0050-03", strength: "400mg", form: "capsule", manufacturer: "Ascend", packSize: 500, packUnit: "EA", description: "Gabapentin 400mg Cap (Ascend) 500ct", isGeneric: true, abRating: "AB" },
  { id: "pr062", drugId: "d007", ndc: "00071-0805-24", strength: "300mg", form: "capsule", manufacturer: "Pfizer (Neurontin)", packSize: 100, packUnit: "EA", description: "Neurontin 300mg Cap (Pfizer) 100ct", isGeneric: false, abRating: "AB" },

  // ── Metoprolol Succinate products ──
  { id: "pr070", drugId: "d008", ndc: "00378-1025-01", strength: "25mg", form: "tablet, extended release", manufacturer: "Mylan", packSize: 100, packUnit: "EA", description: "Metoprolol Succ ER 25mg Tab (Mylan) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr071", drugId: "d008", ndc: "00378-1050-01", strength: "50mg", form: "tablet, extended release", manufacturer: "Mylan", packSize: 100, packUnit: "EA", description: "Metoprolol Succ ER 50mg Tab (Mylan) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr072", drugId: "d008", ndc: "00186-1088-05", strength: "25mg", form: "tablet, extended release", manufacturer: "AstraZeneca (Toprol-XL)", packSize: 100, packUnit: "EA", description: "Toprol-XL 25mg Tab (AstraZeneca) 100ct", isGeneric: false, abRating: "AB" },

  // ── Oxycodone products (C-II) ──
  { id: "pr080", drugId: "d011", ndc: "59011-0410-10", strength: "5mg", form: "tablet", manufacturer: "Mallinckrodt", packSize: 100, packUnit: "EA", description: "Oxycodone HCl 5mg Tab (Mallinckrodt) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr081", drugId: "d011", ndc: "59011-0420-10", strength: "10mg", form: "tablet", manufacturer: "Mallinckrodt", packSize: 100, packUnit: "EA", description: "Oxycodone HCl 10mg Tab (Mallinckrodt) 100ct", isGeneric: true, abRating: "AB" },

  // ── Hydrocodone/APAP products (C-II) ──
  { id: "pr085", drugId: "d013", ndc: "52544-0161-01", strength: "5/325mg", form: "tablet", manufacturer: "Watson (Norco)", packSize: 100, packUnit: "EA", description: "Hydrocodone/APAP 5/325mg Tab (Watson) 100ct", isGeneric: false, abRating: "AB" },
  { id: "pr086", drugId: "d013", ndc: "00406-0123-01", strength: "10/325mg", form: "tablet", manufacturer: "Mallinckrodt", packSize: 100, packUnit: "EA", description: "Hydrocodone/APAP 10/325mg Tab (Mallinckrodt) 100ct", isGeneric: true, abRating: "AB" },

  // ── Alprazolam products (C-IV) ──
  { id: "pr090", drugId: "d012", ndc: "00555-0264-02", strength: "0.5mg", form: "tablet", manufacturer: "Barr/Teva", packSize: 100, packUnit: "EA", description: "Alprazolam 0.5mg Tab (Teva) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr091", drugId: "d012", ndc: "00009-0055-01", strength: "0.5mg", form: "tablet", manufacturer: "Pfizer (Xanax)", packSize: 100, packUnit: "EA", description: "Xanax 0.5mg Tab (Pfizer) 100ct", isGeneric: false, abRating: "AB" },
  { id: "pr092", drugId: "d012", ndc: "00555-0269-02", strength: "1mg", form: "tablet", manufacturer: "Barr/Teva", packSize: 100, packUnit: "EA", description: "Alprazolam 1mg Tab (Teva) 100ct", isGeneric: true, abRating: "AB" },

  // ── Amoxicillin products ──
  { id: "pr100", drugId: "d015", ndc: "65862-0002-01", strength: "500mg", form: "capsule", manufacturer: "Aurobindo", packSize: 100, packUnit: "EA", description: "Amoxicillin 500mg Cap (Aurobindo) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr101", drugId: "d015", ndc: "65862-0003-01", strength: "875mg", form: "tablet", manufacturer: "Aurobindo", packSize: 20, packUnit: "EA", description: "Amoxicillin 875mg Tab (Aurobindo) 20ct", isGeneric: true, abRating: "AB" },

  // ── Montelukast products ──
  { id: "pr110", drugId: "d010", ndc: "00093-7612-56", strength: "10mg", form: "tablet", manufacturer: "Teva", packSize: 90, packUnit: "EA", description: "Montelukast 10mg Tab (Teva) 90ct", isGeneric: true, abRating: "AB" },
  { id: "pr111", drugId: "d010", ndc: "00006-0117-31", strength: "10mg", form: "tablet", manufacturer: "Merck (Singulair)", packSize: 30, packUnit: "EA", description: "Singulair 10mg Tab (Merck) 30ct", isGeneric: false, abRating: "AB" },

  // ── Levothyroxine products ──
  { id: "pr120", drugId: "d009", ndc: "00074-6629-90", strength: "100mcg", form: "tablet", manufacturer: "AbbVie (Synthroid)", packSize: 90, packUnit: "EA", description: "Synthroid 100mcg Tab (AbbVie) 90ct", isGeneric: false, abRating: "AB" },
  { id: "pr121", drugId: "d009", ndc: "00378-1810-01", strength: "75mcg", form: "tablet", manufacturer: "Mylan", packSize: 100, packUnit: "EA", description: "Levothyroxine 75mcg Tab (Mylan) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr122", drugId: "d009", ndc: "00378-1812-01", strength: "100mcg", form: "tablet", manufacturer: "Mylan", packSize: 100, packUnit: "EA", description: "Levothyroxine 100mcg Tab (Mylan) 100ct", isGeneric: true, abRating: "AB" },

  // ── Prednisone products ──
  { id: "pr130", drugId: "d017", ndc: "00054-4728-25", strength: "5mg", form: "tablet", manufacturer: "Roxane", packSize: 100, packUnit: "EA", description: "Prednisone 5mg Tab (Roxane) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr131", drugId: "d017", ndc: "00054-4730-25", strength: "20mg", form: "tablet", manufacturer: "Roxane", packSize: 100, packUnit: "EA", description: "Prednisone 20mg Tab (Roxane) 100ct", isGeneric: true, abRating: "AB" },

  // ── Tramadol products (C-IV) ──
  { id: "pr140", drugId: "d014", ndc: "00045-0659-60", strength: "50mg", form: "tablet", manufacturer: "Amneal", packSize: 100, packUnit: "EA", description: "Tramadol HCl 50mg Tab (Amneal) 100ct", isGeneric: true, abRating: "AB" },
];

const PRESCRIBER_DATABASE = [
  { id: "pr001", firstName: "Sarah", lastName: "Kim", credentials: "MD", dea: "AK1234563", npi: "1234567890", practice: "Front Range Internal Medicine", phone: "(970) 555-1100" },
  { id: "pr002", firstName: "James", lastName: "Park", credentials: "DO", dea: "BP2345674", npi: "2345678901", practice: "Poudre Valley Family Practice", phone: "(970) 555-1200" },
  { id: "pr003", firstName: "Maria", lastName: "Lopez", credentials: "MD", dea: "BL3456785", npi: "3456789012", practice: "Foothills Cardiology", phone: "(970) 555-1300" },
  { id: "pr004", firstName: "Robert", lastName: "Chen", credentials: "NP", dea: "MC4567896", npi: "4567890123", practice: "UCHealth Urgent Care", phone: "(970) 555-1400" },
  { id: "pr005", firstName: "Emily", lastName: "Thompson", credentials: "PA", dea: "FT5678907", npi: "5678901234", practice: "Mountain View Orthopedics", phone: "(970) 555-1500" },
  { id: "pr006", firstName: "Daniel", lastName: "Nguyen", credentials: "DDS", dea: "BN6789018", npi: "6789012345", practice: "Fort Collins Dental Group", phone: "(970) 555-1600" },
];

// ── Mock E-Orders (simulating incoming NCPDP SCRIPT data) ──
// Raw fielded data as it arrives from the prescriber's EHR
const MOCK_EORDERS = {
  p1: {
    messageId: "MSG-20260226-001",
    receivedAt: "2026-02-26T14:32:00Z",
    // Raw NCPDP-style fields
    raw: {
      messageType: "NEWRX",
      drugDescription: "Norvasc 5mg Oral Tablet",
      drugNDC: "00069-1530-30",
      drugCodedName: "amlodipine besylate",
      drugStrength: "5 mg",
      drugForm: "TAB",
      drugQuantity: "30",
      drugDaysSupply: "30",
      refillsAuthorized: "5",
      substitutionCode: "0",
      sigText: "TAKE 1 TABLET BY MOUTH ONCE DAILY FOR BLOOD PRESSURE",
      sigCode: "1 TAB PO QD",
      prescriberLastName: "Kim",
      prescriberFirstName: "Sarah",
      prescriberDEA: "AK1234563",
      prescriberNPI: "1234567890",
      prescriberPhone: "9705551100",
      prescriberAddress: "200 W Mountain Ave, Fort Collins CO 80521",
      patientLastName: "Johnson",
      patientFirstName: "Margaret",
      patientDOB: "19520315",
      dateWritten: "20260226",
      note: "",
    },
    // Human-readable transcription
    transcribed: {
      drug: "Norvasc (amlodipine) 5mg tablet",
      sig: "Take 1 tablet by mouth once daily for blood pressure",
      qty: 30,
      daySupply: 30,
      refills: 5,
      daw: 0,
      prescriber: "Dr. Sarah Kim, MD",
      prescriberDEA: "AK1234563",
      dateWritten: "02/26/2026",
      patient: "Margaret Johnson",
      patientDOB: "03/15/1952",
    },
  },
  p2: {
    messageId: "MSG-20260226-002",
    receivedAt: "2026-02-26T15:05:00Z",
    raw: {
      messageType: "NEWRX",
      drugDescription: "Singulair 10mg Oral Tablet",
      drugNDC: "00006-0117-31",
      drugCodedName: "montelukast sodium",
      drugStrength: "10 mg",
      drugForm: "TAB",
      drugQuantity: "30",
      drugDaysSupply: "30",
      refillsAuthorized: "11",
      substitutionCode: "0",
      sigText: "TAKE 1 TABLET BY MOUTH AT BEDTIME",
      sigCode: "1 TAB PO QHS",
      prescriberLastName: "Park",
      prescriberFirstName: "James",
      prescriberDEA: "BP2345674",
      prescriberNPI: "2345678901",
      prescriberPhone: "9705551200",
      prescriberAddress: "1100 Lemay Ave, Fort Collins CO 80524",
      patientLastName: "Chen",
      patientFirstName: "David",
      patientDOB: "19850722",
      dateWritten: "20260226",
      note: "Patient reports seasonal allergies worsening",
    },
    transcribed: {
      drug: "Singulair (montelukast) 10mg tablet",
      sig: "Take 1 tablet by mouth at bedtime",
      qty: 30,
      daySupply: 30,
      refills: 11,
      daw: 0,
      prescriber: "Dr. James Park, DO",
      prescriberDEA: "BP2345674",
      dateWritten: "02/26/2026",
      patient: "David Chen",
      patientDOB: "07/22/1985",
      note: "Patient reports seasonal allergies worsening",
    },
  },
  p3: {
    messageId: "MSG-20260226-003",
    receivedAt: "2026-02-26T13:48:00Z",
    raw: {
      messageType: "NEWRX",
      drugDescription: "Toprol-XL 25mg Oral Tablet Extended Release",
      drugNDC: "00186-1092-05",
      drugCodedName: "metoprolol succinate",
      drugStrength: "25 mg",
      drugForm: "TAB,SA",
      drugQuantity: "30",
      drugDaysSupply: "30",
      refillsAuthorized: "5",
      substitutionCode: "0",
      sigText: "TAKE 1 TABLET BY MOUTH ONCE DAILY",
      sigCode: "1 TAB PO QD",
      prescriberLastName: "Lopez",
      prescriberFirstName: "Maria",
      prescriberDEA: "BL3456785",
      prescriberNPI: "3456789012",
      prescriberPhone: "9705551300",
      prescriberAddress: "1024 S Lemay Ave Ste 200, Fort Collins CO 80524",
      patientLastName: "Martinez",
      patientFirstName: "Rosa",
      patientDOB: "19681103",
      dateWritten: "20260225",
      note: "Adding for newly diagnosed HTN - start low dose",
    },
    transcribed: {
      drug: "Toprol-XL (metoprolol succinate) 25mg ER tablet",
      sig: "Take 1 tablet by mouth once daily",
      qty: 30,
      daySupply: 30,
      refills: 5,
      daw: 0,
      prescriber: "Dr. Maria Lopez, MD",
      prescriberDEA: "BL3456785",
      dateWritten: "02/25/2026",
      patient: "Rosa Martinez",
      patientDOB: "11/03/1968",
      note: "Adding for newly diagnosed HTN - start low dose",
    },
  },
};

// ── Drug Matching ──
// Attempts to match an incoming drug description against the local drug file.
// Returns { drug, strength, confidence } or null.
function matchDrugFromEOrder(rawFields) {
  const desc = (rawFields.drugDescription || "").toLowerCase();
  const coded = (rawFields.drugCodedName || "").toLowerCase();
  const incomingStrength = (rawFields.drugStrength || "").replace(/\s/g, "").toLowerCase();

  let bestMatch = null;
  let bestScore = 0;

  for (const drug of DRUG_DATABASE) {
    let score = 0;
    const name = drug.name.toLowerCase();
    const brands = drug.brandNames.map(b => b.toLowerCase());

    // Exact generic name match in coded field
    if (coded.includes(name)) score += 50;
    // Generic name in description
    else if (desc.includes(name)) score += 40;
    // Brand name match
    for (const brand of brands) {
      if (desc.includes(brand)) score += 45;
      if (coded.includes(brand)) score += 35;
    }

    // Strength match
    const normalizedStrengths = drug.strengths.map(s => s.replace(/\s/g, "").toLowerCase());
    if (normalizedStrengths.includes(incomingStrength)) score += 20;

    // Form match (loose)
    const rawForm = (rawFields.drugForm || "").toLowerCase();
    const drugForm = drug.form.toLowerCase();
    if (rawForm.includes("tab") && drugForm.includes("tablet")) score += 5;
    if (rawForm.includes("cap") && drugForm.includes("capsule")) score += 5;

    if (score > bestScore) {
      bestScore = score;
      // Find best strength match
      let matchedStrength = drug.strengths[0];
      if (normalizedStrengths.includes(incomingStrength)) {
        const idx = normalizedStrengths.indexOf(incomingStrength);
        matchedStrength = drug.strengths[idx];
      }
      bestMatch = { drug, strength: matchedStrength, score };
    }
  }

  if (!bestMatch || bestMatch.score < 30) return null;

  return {
    drug: bestMatch.drug,
    strength: bestMatch.strength,
    confidence: bestMatch.score >= 60 ? "high" : bestMatch.score >= 40 ? "medium" : "low",
  };
}

// ── Prescriber Matching ──
function matchPrescriberFromEOrder(rawFields) {
  const dea = (rawFields.prescriberDEA || "").toUpperCase();
  const npi = rawFields.prescriberNPI || "";
  const lastName = (rawFields.prescriberLastName || "").toLowerCase();

  // DEA match is strongest
  if (dea) {
    const match = PRESCRIBER_DATABASE.find(p => p.dea.toUpperCase() === dea);
    if (match) return { prescriber: match, confidence: "high" };
  }
  // NPI match
  if (npi) {
    const match = PRESCRIBER_DATABASE.find(p => p.npi === npi);
    if (match) return { prescriber: match, confidence: "high" };
  }
  // Last name fallback
  if (lastName) {
    const matches = PRESCRIBER_DATABASE.filter(p => p.lastName.toLowerCase() === lastName);
    if (matches.length === 1) return { prescriber: matches[0], confidence: "medium" };
  }
  return null;
}


// ── Mock Data Provider Implementation ──
function createMockDataProvider() {
  return {
    searchDrugs: (query) => {
      if (!query || query.length < 2) return [];

      // ── Comma-delimited multi-field search: name,strength,form ──
      const parts = query.split(",").map(p => p.trim().toLowerCase()).filter(Boolean);
      const nameQ = parts[0] || "";
      const strengthQ = parts[1] || "";
      const formQ = parts[2] || "";

      if (nameQ.length < 2) return [];

      return DRUG_DATABASE
        .filter(d => {
          // Name/brand match (required)
          const nameMatch = d.name.toLowerCase().includes(nameQ) ||
            d.brandNames.some(b => b.toLowerCase().includes(nameQ)) ||
            d.drugClass.toLowerCase().includes(nameQ);
          if (!nameMatch) return false;

          // Strength filter (if provided)
          if (strengthQ) {
            const hasStrength = d.strengths.some(s => s.toLowerCase().includes(strengthQ));
            if (!hasStrength) return false;
          }

          // Form filter (if provided)
          if (formQ) {
            const formLower = d.form.toLowerCase();
            if (!formLower.includes(formQ)) return false;
          }

          return true;
        })
        .map(d => {
          // Relevance scoring
          let score = 100;
          const name = d.name.toLowerCase();
          if (name === nameQ) score = 0;
          else if (name.startsWith(nameQ)) score = 10;
          else if (name.split(/[\s\/\-]/).some(w => w.startsWith(nameQ))) score = 20;
          else if (d.brandNames.some(b => b.toLowerCase().startsWith(nameQ))) score = 30;
          else if (d.brandNames.some(b => b.toLowerCase().includes(nameQ))) score = 40;
          else if (name.includes(nameQ)) score = 50;
          else score = 60;

          // Find best matching strength for display hint
          let matchedStrength = null;
          if (strengthQ) {
            matchedStrength = d.strengths.find(s => s.toLowerCase() === strengthQ) ||
              d.strengths.find(s => s.toLowerCase().startsWith(strengthQ)) ||
              d.strengths.find(s => s.toLowerCase().includes(strengthQ));
            if (matchedStrength) score -= 5; // boost exact strength matches
          }

          return { ...d, _score: score, _matchedStrength: matchedStrength };
        })
        .sort((a, b) => a._score - b._score || a.name.localeCompare(b.name))
        .slice(0, 12);
    },

    searchPrescribers: (query) => {
      if (!query || query.length < 2) return [];
      const q = query.toLowerCase();
      return PRESCRIBER_DATABASE
        .filter(p =>
          `${p.firstName} ${p.lastName}`.toLowerCase().includes(q) ||
          p.lastName.toLowerCase().includes(q) ||
          p.dea.toLowerCase().includes(q) ||
          p.npi.includes(q) ||
          p.practice.toLowerCase().includes(q)
        )
        .map(p => {
          let score = 100;
          const last = p.lastName.toLowerCase();
          const full = `${p.firstName} ${p.lastName}`.toLowerCase();
          if (last === q) score = 0;
          else if (last.startsWith(q)) score = 10;
          else if (full.startsWith(q)) score = 15;
          else if (p.dea.toLowerCase().startsWith(q) || p.npi.startsWith(q)) score = 20;
          else if (last.includes(q)) score = 30;
          else score = 50;
          return { ...p, _score: score };
        })
        .sort((a, b) => a._score - b._score || a.lastName.localeCompare(b.lastName))
        .slice(0, 8);
    },

    getDrug: (id) => DRUG_DATABASE.find(d => d.id === id) || null,
    getPrescriber: (id) => PRESCRIBER_DATABASE.find(p => p.id === id) || null,
    getProduct: (id) => PRODUCT_DATABASE.find(p => p.id === id) || null,
    getProductByNdc: (ndc) => PRODUCT_DATABASE.find(p => p.ndc.replace(/-/g, "") === ndc.replace(/-/g, "")) || null,
    getProductsForDrug: (drugId, strength) => {
      return PRODUCT_DATABASE
        .filter(p => p.drugId === drugId && (!strength || p.strength === strength))
        .sort((a, b) => {
          // Generics first, then by manufacturer name
          if (a.isGeneric !== b.isGeneric) return a.isGeneric ? -1 : 1;
          return a.manufacturer.localeCompare(b.manufacturer);
        });
    },

    // E-Order methods
    getEOrder: (patientId) => MOCK_EORDERS[patientId] || null,

    getAllEOrders: () => {
      return Object.entries(MOCK_EORDERS).map(([patientId, eOrder]) => {
        const patient = MOCK_PATIENTS.find(p => p.id === patientId);
        return { ...eOrder, patientId, patient };
      }).sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
    },

    resolveEOrder: (eOrder) => {
      // Attempt to auto-match drug and prescriber from e-order fields
      const drugMatch = matchDrugFromEOrder(eOrder.raw);
      const prescriberMatch = matchPrescriberFromEOrder(eOrder.raw);
      return {
        drug: drugMatch,        // { drug, strength, confidence } | null
        prescriber: prescriberMatch, // { prescriber, confidence } | null
        qty: parseInt(eOrder.raw.drugQuantity, 10) || null,
        daySupply: parseInt(eOrder.raw.drugDaysSupply, 10) || null,
        refills: parseInt(eOrder.raw.refillsAuthorized, 10) ?? null,
        daw: parseInt(eOrder.raw.substitutionCode, 10) || 0,
        sig: eOrder.transcribed.sig || eOrder.raw.sigText || "",
      };
    },

    submitRx: (rxData) => {
      const rxNumber = `RX-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;
      console.log("[PharmIDE] Rx submitted:", { rxNumber, ...rxData });
      return { rxNumber, status: "entered", timestamp: new Date().toISOString() };
    },

    // Validation helpers the form can call
    getRefillLimit: (schedule) => {
      if (schedule === "C-II") return 0;
      if (schedule === "C-III" || schedule === "C-IV" || schedule === "C-V") return 5;
      return 99; // No legal limit for non-controlled
    },

    getScheduleLabel: (schedule) => {
      const labels = { "C-II": "Schedule II", "C-III": "Schedule III", "C-IV": "Schedule IV", "C-V": "Schedule V", "Rx": "Rx Only", "OTC": "OTC" };
      return labels[schedule] || schedule;
    },
  };
}


// ============================================================
// CONSTANTS & CONFIG
// ============================================================
const WORKSPACE_COLORS = [
  { name: "Ruby", bg: "#e45858", light: "#1f1418", mid: "#2d1a1e", border: "#3d2228", text: "#f0a0a0" },
  { name: "Ocean", bg: "#5b8af5", light: "#141a24", mid: "#1a2236", border: "#223050", text: "#a0bff0" },
  { name: "Emerald", bg: "#4abe6a", light: "#141f18", mid: "#1a2d20", border: "#223d28", text: "#90e0a0" },
  { name: "Amber", bg: "#e8a030", light: "#1f1a14", mid: "#2d2418", border: "#3d3020", text: "#f0d090" },
  { name: "Violet", bg: "#9b6ef0", light: "#1a1424", mid: "#221a36", border: "#302250", text: "#c0a0f0" },
  { name: "Rose", bg: "#f06088", light: "#1f1418", mid: "#2d1a22", border: "#3d2230", text: "#f0a0b8" },
  { name: "Teal", bg: "#40c0b0", light: "#141f1e", mid: "#1a2d2a", border: "#223d38", text: "#90e0d0" },
  { name: "Slate", bg: "#7088a8", light: "#181a1e", mid: "#1e2228", border: "#283040", text: "#a8b8d0" },
];

const TAB_TYPES = {
  RX_ENTRY: { label: "Rx Entry", icon: "Rx" },
  RPH_VERIFY: { label: "RPh Verify", icon: "Rv" },
  FILL: { label: "Fill", icon: "Fl" },
  FILL_VERIFY: { label: "Fill Verify", icon: "Fv" },
  DATA_ENTRY_WS: { label: "Data Entry", icon: "De" },
  PATIENT_PROFILE: { label: "Patient Profile", icon: "Pt" },
  MED_HISTORY: { label: "Med History", icon: "Hx" },
  INSURANCE: { label: "Insurance", icon: "Ins" },
  ALLERGIES: { label: "Allergies", icon: "Al" },
  NOTES: { label: "Notes", icon: "Nt" },
  INVENTORY: { label: "Inventory", icon: "Inv" },
};

const GRID_COLS = 12;
const GRID_ROWS = 8;
const SNAP_SIZES = {
  FULL: { cols: 12, rows: 8, label: "Full",
    icon: (c) => <svg width="14" height="10" viewBox="0 0 14 10"><rect x="0.5" y="0.5" width="13" height="9" rx="1" fill={c} stroke="currentColor" strokeWidth="0.5"/></svg> },
  HALF_H: { cols: 6, rows: 8, label: "Half",
    icon: (c) => <svg width="14" height="10" viewBox="0 0 14 10"><rect x="0.5" y="0.5" width="6" height="9" rx="1" fill={c} stroke="currentColor" strokeWidth="0.5"/><rect x="7.5" y="0.5" width="6" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="1.5 1"/></svg> },
  HALF_V: { cols: 12, rows: 4, label: "Half-V",
    icon: (c) => <svg width="14" height="10" viewBox="0 0 14 10"><rect x="0.5" y="0.5" width="13" height="4" rx="1" fill={c} stroke="currentColor" strokeWidth="0.5"/><rect x="0.5" y="5.5" width="13" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="1.5 1"/></svg> },
  QUARTER: { cols: 6, rows: 4, label: "Quarter",
    icon: (c) => <svg width="14" height="10" viewBox="0 0 14 10"><rect x="0.5" y="0.5" width="6" height="4" rx="1" fill={c} stroke="currentColor" strokeWidth="0.5"/><rect x="7.5" y="0.5" width="6" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="1.5 1"/><rect x="0.5" y="5.5" width="6" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="1.5 1"/><rect x="7.5" y="5.5" width="6" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="1.5 1"/></svg> },
  THIRD: { cols: 4, rows: 8, label: "Third",
    icon: (c) => <svg width="14" height="10" viewBox="0 0 14 10"><rect x="0.5" y="0.5" width="3.7" height="9" rx="1" fill={c} stroke="currentColor" strokeWidth="0.5"/><rect x="5.15" y="0.5" width="3.7" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="1.5 1"/><rect x="9.8" y="0.5" width="3.7" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="1.5 1"/></svg> },
};

const DAW_CODES = [
  { value: 0, label: "0 — No product selection indicated" },
  { value: 1, label: "1 — Substitution not allowed by prescriber" },
  { value: 2, label: "2 — Patient requested brand" },
  { value: 3, label: "3 — Pharmacist selected brand" },
  { value: 4, label: "4 — Generic not in stock" },
  { value: 5, label: "5 — Brand dispensed as generic" },
  { value: 7, label: "7 — Brand mandated by law" },
  { value: 8, label: "8 — Generic not available" },
  { value: 9, label: "9 — Other" },
];

// ============================================================
// MOCK PATIENT DATA
// ============================================================
const MOCK_PATIENTS = [
  {
    id: "p1", name: "Margaret Johnson", dob: "03/15/1952",
    phone: "(970) 555-0142", address: "412 Maple St, Fort Collins, CO 80521",
    allergies: ["Penicillin", "Sulfa drugs"],
    insurance: { plan: "Blue Cross Blue Shield", memberId: "BCB-882741", group: "GRP-4401", copay: "$10/$30/$50" },
    medications: [
      { name: "Lisinopril 10mg", directions: "Take 1 tablet daily", qty: 30, refills: 5, lastFill: "2026-01-15" },
      { name: "Metformin 500mg", directions: "Take 1 tablet twice daily", qty: 60, refills: 3, lastFill: "2026-01-20" },
      { name: "Atorvastatin 20mg", directions: "Take 1 tablet at bedtime", qty: 30, refills: 11, lastFill: "2026-02-01" },
    ],
    notes: "Prefers afternoon pickup. Hard of hearing — speak clearly. Daughter (Lisa) sometimes picks up.",
  },
  {
    id: "p2", name: "David Chen", dob: "07/22/1985",
    phone: "(970) 555-0287", address: "1890 College Ave, Fort Collins, CO 80524",
    allergies: ["Codeine"],
    insurance: { plan: "Aetna PPO", memberId: "AET-339102", group: "GRP-7782", copay: "$5/$25/$45" },
    medications: [
      { name: "Escitalopram 10mg", directions: "Take 1 tablet daily", qty: 30, refills: 5, lastFill: "2026-02-10" },
      { name: "Omeprazole 20mg", directions: "Take 1 capsule before breakfast", qty: 30, refills: 2, lastFill: "2026-01-28" },
    ],
    notes: "Requests generic when available. Works remotely — flexible pickup times.",
  },
  {
    id: "p3", name: "Rosa Martinez", dob: "11/03/1968",
    phone: "(970) 555-0391", address: "2205 Timberline Rd, Fort Collins, CO 80525",
    allergies: ["Aspirin", "NSAIDs", "Latex"],
    insurance: { plan: "Medicare Part D - SilverScript", memberId: "MBI-1H4TE92", group: "N/A", copay: "$3.35/$9.85" },
    medications: [
      { name: "Amlodipine 5mg", directions: "Take 1 tablet daily", qty: 30, refills: 6, lastFill: "2026-02-05" },
      { name: "Levothyroxine 75mcg", directions: "Take 1 tablet every morning on empty stomach", qty: 30, refills: 5, lastFill: "2026-02-05" },
      { name: "Gabapentin 300mg", directions: "Take 1 capsule three times daily", qty: 90, refills: 3, lastFill: "2026-01-25" },
      { name: "Vitamin D3 2000IU", directions: "Take 1 tablet daily", qty: 30, refills: 11, lastFill: "2026-02-01" },
    ],
    notes: "Spanish speaking — prefers bilingual staff. Has difficulty with child-resistant caps. Diabetic — monitor for interactions.",
  },
];


// ============================================================
// INLINE SEARCH COMPONENT (reused for drug + prescriber)
// ============================================================
function InlineSearch({ placeholder, onSearch, onSelect, renderItem, renderSelected, selected, color, autoFocus, tabIndex }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [hlIndex, setHlIndex] = useState(0);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (query.length >= 2) {
      const result = onSearch(query);
      if (result && typeof result.then === 'function') {
        result.then(r => {
          if (cancelled) return;
          setResults(r || []);
          setOpen((r || []).length > 0);
          setHlIndex(0);
        });
      } else {
        setResults(result || []);
        setOpen((result || []).length > 0);
        setHlIndex(0);
      }
    } else {
      setResults([]);
      setOpen(false);
    }
    return () => { cancelled = true; };
  }, [query, onSearch]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = (item) => {
    onSelect(item);
    setQuery("");
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      setHlIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      setHlIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && results[hlIndex]) {
      e.preventDefault();
      handleSelect(results[hlIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && !query && selected) {
      onSelect(null);
    }
  };

  const handleClear = (e) => {
    e.stopPropagation();
    onSelect(null);
    setQuery("");
    if (inputRef.current) inputRef.current.focus();
  };

  if (selected) {
    return (
      <div
        tabIndex={tabIndex || 0}
        onKeyDown={(e) => {
          if (e.key === "Tab") return; // let Tab pass through naturally
          if (e.key === "Backspace" || e.key === "Delete") {
            e.preventDefault();
            onSelect(null);
            setTimeout(() => inputRef.current?.focus(), 0);
          } else if (e.key === "Enter" || e.key === " " || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) {
            e.preventDefault();
            onSelect(null);
            // If it was a character key, seed the search with it
            if (e.key.length === 1 && e.key !== " ") {
              setQuery(e.key);
            }
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        onClick={() => { onSelect(null); setTimeout(() => inputRef.current?.focus(), 0); }}
        style={{
          width: "100%", padding: "7px 10px", borderRadius: 6,
          border: `1.5px solid ${color.border}60`, background: color.light,
          fontSize: 13, fontFamily: T.mono,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          cursor: "pointer", color: T.textPrimary, minHeight: 36, boxSizing: "border-box",
          outline: "none",
        }}
        onFocus={(e) => { e.target.style.borderColor = color.bg + "80"; e.target.style.boxShadow = `0 0 0 2px ${color.bg}20`; }}
        onBlur={(e) => { e.target.style.borderColor = color.border + "60"; e.target.style.boxShadow = "none"; }}
      >
        <div style={{ flex: 1, overflow: "hidden" }}>{renderSelected(selected)}</div>
        <span onClick={handleClear} style={{ color: T.textSecondary, cursor: "pointer", fontSize: 14, padding: "0 2px", marginLeft: 8, flexShrink: 0 }}>×</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        tabIndex={tabIndex}
        style={{
          width: "100%", padding: "7px 10px", borderRadius: 6,
          border: `1px solid ${open ? color.bg + "60" : T.inputBorder}`, background: T.surfaceRaised,
          color: T.textPrimary, fontSize: 13, fontFamily: T.mono,
          outline: "none", boxSizing: "border-box", minHeight: 36,
          transition: "border-color 0.15s",
        }}
      />
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0,
          background: T.surfaceRaised, border: `1.5px solid ${color.border}60`,
          borderRadius: 8, overflow: "hidden", zIndex: 200,
          boxShadow: `0 8px 30px ${color.bg}20, 0 2px 8px rgba(0,0,0,0.08)`,
          maxHeight: 220, overflowY: "auto",
        }}>
          {results.map((item, i) => (
            <div
              key={item.id}
              onClick={() => handleSelect(item)}
              onMouseEnter={() => setHlIndex(i)}
              style={{
                padding: "8px 12px", cursor: "pointer",
                background: i === hlIndex ? color.light : "transparent",
                borderBottom: `1px solid ${T.surfaceBorder}`,
                transition: "background 0.1s",
              }}
            >
              {renderItem(item, i === hlIndex)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ============================================================
// RX ENTRY FORM — The real thing
// ============================================================
function RxEntryContent({ patient, workspace }) {
  const data = useDataProvider();
  const { dispatch, canDo } = useContext(PharmIDEContext);
  const color = workspace.color;
  const rxState = workspace.rxPrescription;

  // ── E-Order loading ──
  const eOrder = useMemo(() => data.getEOrder(patient.id), [patient.id, data]);
  const resolved = useMemo(() => eOrder ? data.resolveEOrder(eOrder) : null, [eOrder, data]);

  // ── Form state ──
  const [drug, setDrug] = useState(null);
  const [strength, setStrength] = useState("");
  const [product, setProduct] = useState(null);
  const [prescriber, setPrescriber] = useState(null);
  const [qty, setQty] = useState("");
  const [daySupply, setDaySupply] = useState("");
  const [refills, setRefills] = useState("");
  const [daw, setDaw] = useState(0);
  const [sig, setSig] = useState("");
  const [origRxText, setOrigRxText] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const [showRawFields, setShowRawFields] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // ── Auto-populate from e-order on first render ──
  useEffect(() => {
    if (initialized || !resolved) return;
    if (resolved.drug) {
      setDrug(resolved.drug.drug);
      setStrength(resolved.drug.strength);
    }
    if (resolved.prescriber) {
      setPrescriber(resolved.prescriber.prescriber);
    }
    if (resolved.qty != null) setQty(String(resolved.qty));
    if (resolved.daySupply != null) setDaySupply(String(resolved.daySupply));
    if (resolved.refills != null) setRefills(String(resolved.refills));
    if (resolved.daw != null) setDaw(resolved.daw);
    if (resolved.sig) setSig(resolved.sig);
    setInitialized(true);
  }, [resolved, initialized]);

  // ── Validation ──
  // ── Available products for current drug+strength ──
  const [availableProducts, setAvailableProducts] = useState([]);
  useEffect(() => {
    if (!drug || !strength) { setAvailableProducts([]); return; }
    const result = data.getProductsForDrug(drug.id, strength);
    if (result && typeof result.then === 'function') {
      result.then(products => setAvailableProducts(products || []));
    } else {
      setAvailableProducts(result || []);
    }
  }, [drug, strength, data]);

  // Clear product when drug or strength changes (product no longer valid)
  useEffect(() => {
    if (product && (!drug || product.drugId !== drug.id || product.strength !== strength)) {
      setProduct(null);
    }
  }, [drug, strength]);

  const validations = useMemo(() => {
    const v = {};

    // Refill limit check
    if (drug && refills !== "") {
      const limit = data.getRefillLimit(drug.schedule);
      const r = parseInt(refills, 10);
      if (!isNaN(r)) {
        if (drug.schedule === "C-II" && r > 0) {
          v.refills = { level: "warn", msg: "Schedule II — no refills allowed" };
        } else if (r > limit) {
          v.refills = { level: "warn", msg: `Max ${limit} refills for ${data.getScheduleLabel(drug.schedule)}` };
        }
      }
    }

    // Day supply math check
    if (qty && daySupply && sig) {
      const q = parseInt(qty, 10);
      const ds = parseInt(daySupply, 10);
      if (q > 0 && ds > 0) {
        const sigLower = sig.toLowerCase();
        let perDay = 1;
        if (sigLower.includes("twice") || sigLower.includes("bid") || sigLower.includes("2 times") || sigLower.includes("two times")) perDay = 2;
        else if (sigLower.includes("three times") || sigLower.includes("tid") || sigLower.includes("3 times")) perDay = 3;
        else if (sigLower.includes("four times") || sigLower.includes("qid") || sigLower.includes("4 times")) perDay = 4;
        else if (sigLower.includes("every 4 hours") || sigLower.includes("q4h")) perDay = 6;
        else if (sigLower.includes("every 6 hours") || sigLower.includes("q6h")) perDay = 4;
        else if (sigLower.includes("every 8 hours") || sigLower.includes("q8h")) perDay = 3;
        else if (sigLower.includes("every 12 hours") || sigLower.includes("q12h")) perDay = 2;

        const expectedDays = Math.floor(q / perDay);
        if (Math.abs(expectedDays - ds) > 3) {
          v.daySupply = { level: "warn", msg: `Qty ${q} ÷ ${perDay}/day = ~${expectedDays}d (entered ${ds}d)` };
        }
      }
    }

    // Qty check
    if (qty !== "" && (isNaN(parseInt(qty, 10)) || parseInt(qty, 10) <= 0)) {
      v.qty = { level: "warn", msg: "Qty should be a positive number" };
    }

    return v;
  }, [drug, qty, daySupply, refills, sig, data]);

  // Auto-populate strength when drug changes (but not on initial e-order load or multi-field search)
  const eorderStrengthApplied = useRef(false);
  const skipNextStrengthReset = useRef(false);
  useEffect(() => {
    if (drug) {
      // If we have an e-order drug match and haven't applied it yet, skip resetting
      if (resolved?.drug && !eorderStrengthApplied.current) {
        eorderStrengthApplied.current = true;
        return;
      }
      // If multi-field search already set the strength, skip
      if (skipNextStrengthReset.current) {
        skipNextStrengthReset.current = false;
        return;
      }
      setStrength(drug.strengths[0] || "");
    } else {
      setStrength("");
    }
  }, [drug]);

  const canSubmit = drug && prescriber && product && qty && daySupply && sig && strength && canDo("SUBMIT_RX");

  const handleSubmit = () => {
    if (!canSubmit) return;
    const rxNumber = `RX-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;
    const techEntry = {
      drugId: drug.id, drugName: drug.name, drugBrands: drug.brandNames,
      strength, form: product.form || drug.form, schedule: drug.schedule,
      productId: product.id, productNdc: product.ndc,
      productManufacturer: product.manufacturer, productPackSize: product.packSize,
      productIsGeneric: product.isGeneric, productDescription: product.description,
      prescriberId: prescriber.id,
      prescriberName: `Dr. ${prescriber.lastName}, ${prescriber.firstName}`,
      prescriberCredentials: prescriber.credentials,
      prescriberDEA: prescriber.dea,
      qty: parseInt(qty, 10), daySupply: parseInt(daySupply, 10),
      refills: parseInt(refills, 10) || 0, daw, sig,
      originalRxText: origRxText,
    };
    dispatch({
      type: "SUBMIT_RX", workspaceId: workspace.id,
      techEntry, eOrder: eOrder || null, rxNumber,
    });
  };

  const handleReset = () => {
    dispatch({ type: "RESET_RX", workspaceId: workspace.id });
    setDrug(null); setStrength(""); setProduct(null); setPrescriber(null);
    setQty(""); setDaySupply(""); setRefills("");
    setDaw(0); setSig(""); setOrigRxText("");
    setShowOriginal(false); setShowRawFields(false);
    setInitialized(false);
  };

  // Field styling helpers
  const fieldLabel = (text, required) => (
    <label style={{
      display: "block", fontSize: 10, fontWeight: 600,
      color: T.textSecondary, textTransform: "uppercase", letterSpacing: 1,
      marginBottom: 4, fontFamily: T.mono,
    }}>
      {text}{required && <span style={{ color: "#e45858", marginLeft: 2 }}>*</span>}
    </label>
  );

  const fieldInput = (props) => ({
    style: {
      width: "100%", padding: "8px 12px", borderRadius: T.radiusSm,
      border: `1px solid ${T.inputBorder}`, background: T.inputBg,
      color: T.inputText, fontSize: 14, fontFamily: T.sans,
      outline: "none", boxSizing: "border-box", minHeight: 38,
      transition: "border-color 0.15s",
      ...props?.style,
    },
    onFocus: (e) => { e.target.style.borderColor = color.bg + "60"; },
    onBlur: (e) => { e.target.style.borderColor = T.inputBorder; },
  });

  const validationBadge = (key) => {
    const v = validations[key];
    if (!v) return null;
    return (
      <div style={{
        fontSize: 11, marginTop: 3, padding: "3px 8px", borderRadius: T.radiusXs,
        background: "#e8a03015",
        color: "#e8a030",
        border: "1px solid #e8a03030",
        fontFamily: T.mono,
      }}>
        {v.msg}
      </div>
    );
  };

  // ── Status-gated rendering ──
  // If Rx has been submitted and is in any post-entry status, show read-only
  if (rxState && rxState.status !== "returned") {
    const statusConfig = {
      in_review: { color: "#e8a030", bg: "#1f1a14", border: "#3d3020", icon: "", label: "Awaiting Pharmacist Verification" },
      approved: { color: "#4abe6a", bg: "#162018", border: "#1a3d22", icon: "", label: "Approved" },
      call_prescriber: { color: "#e45858", bg: "#1f1418", border: "#3d2228", icon: "", label: "Call Prescriber Required" },
    };
    const sc = statusConfig[rxState.status] || statusConfig.in_review;
    const te = rxState.techEntry;

    return (
      <div style={{ padding: 16, fontFamily: T.sans, fontSize: 14, color: T.textPrimary }}>
        {/* Status banner */}
        <div style={{
          padding: "12px 16px", borderRadius: 8, marginBottom: 12,
          background: sc.bg, border: `1.5px solid ${sc.border}`,
          display: "flex", alignItems: "center", gap: 10,
          fontFamily: T.mono,
        }}>
          
          <div>
            <div style={{ fontWeight: 800, color: sc.color, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>
              {sc.label}
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
              {rxState.rxNumber} · Submitted {new Date(rxState.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
        </div>

        {/* Pharmacist notes (if returned or has review) */}
        {rxState.rphReview?.notes && (
          <div style={{
            padding: "10px 14px", borderRadius: 8, marginBottom: 12,
            background: "#1a1424", border: "1px solid #302250",
            fontSize: 12, color: "#9b6ef0", lineHeight: 1.5,
          }}>
            <strong style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Pharmacist Notes:</strong>
            <div style={{ marginTop: 4 }}>{rxState.rphReview.notes}</div>
          </div>
        )}

        {/* Read-only entry summary */}
        <div style={{
          padding: 14, borderRadius: 8, background: T.surface, border: `1px solid ${T.surfaceBorder}`,
          fontFamily: T.mono, fontSize: 12, lineHeight: 1.8,
          opacity: 0.85,
        }}>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>Drug</span><strong>{te.drugName} {te.strength}</strong></div>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>Product</span>{te.productNdc} <span style={{ color: T.textSecondary, marginLeft: 4 }}>{te.productManufacturer} · {te.productPackSize}ct</span></div>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>SIG</span>{te.sig}</div>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>Qty</span>{te.qty} <span style={{ color: T.textSecondary, marginLeft: 8 }}>Day supply: {te.daySupply}</span> <span style={{ color: T.textSecondary, marginLeft: 8 }}>Refills: {te.refills}</span></div>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>Prescriber</span>{te.prescriberName}, {te.prescriberCredentials}</div>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>DAW</span>{te.daw}</div>
        </div>

        {rxState.status === "approved" && (
          <button onClick={handleReset} style={{
            marginTop: 12, width: "100%", padding: "10px 16px", borderRadius: 8,
            border: "none", cursor: "pointer",
            background: `linear-gradient(135deg, ${color.bg}, ${color.bg}dd)`,
            color: "#fff", fontSize: 13, fontWeight: 800, textTransform: "uppercase",
            letterSpacing: 1, fontFamily: T.mono,
          }}>New Rx</button>
        )}
      </div>
    );
  }

  // If returned, the form is editable again — pre-populate from the returned techEntry
  // (The normal form renders below with existing state)

  return (
    <div style={{ padding: 16, fontFamily: T.sans, fontSize: 14, color: T.textPrimary }}>
      {/* ── Allergy Banner ── */}
      {patient.allergies.length > 0 && (
        <div style={{
          padding: "8px 12px", borderRadius: 8, marginBottom: 12,
          background: "#1f1418", border: "1px solid #3d2228",
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 12, color: "#e45858", fontWeight: 700,
          fontFamily: T.mono,
        }}>
          
          <span>ALLERGIES: {patient.allergies.join(" · ")}</span>
        </div>
      )}

      {/* ── Drug Schedule Badge ── */}
      {drug && ["C-II", "C-III", "C-IV", "C-V"].includes(drug.schedule) && (
        <div style={{
          padding: "6px 12px", borderRadius: 8, marginBottom: 12,
          background: "#1f1a14", border: "1px solid #3d3020",
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 12, color: "#e8a030", fontWeight: 700,
          fontFamily: T.mono,
        }}>
          
          <span>CONTROLLED: {data.getScheduleLabel(drug.schedule)}</span>
          {drug.schedule === "C-II" && <span style={{ fontWeight: 400, marginLeft: 4 }}>— No refills, written Rx required</span>}
        </div>
      )}

      {/* ── E-Order Reference (two layers) ── */}
      {eOrder ? (
        <div style={{ marginBottom: 12 }}>
          {/* Layer 1: Human-readable transcription — always visible */}
          <div style={{
            padding: "12px 14px", borderRadius: 8,
            background: T.surface, border: `1px solid ${T.surfaceBorder}`,
            fontFamily: T.mono, fontSize: 12, lineHeight: 1.7,
          }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 8,
            }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: "#5b8af5", textTransform: "uppercase", letterSpacing: 1 }}>
                E-Script — {eOrder.messageId}
              </span>
              <span style={{ fontSize: 10, color: T.textMuted }}>
                {new Date(eOrder.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: "3px 10px" }}>
              <span style={{ color: "#5b8af5", fontWeight: 600 }}>Drug</span>
              <span style={{ fontWeight: 700, color: T.textPrimary }}>{eOrder.transcribed.drug}</span>
              <span style={{ color: "#5b8af5", fontWeight: 600 }}>SIG</span>
              <span>{eOrder.transcribed.sig}</span>
              <span style={{ color: "#5b8af5", fontWeight: 600 }}>Qty</span>
              <span>{eOrder.transcribed.qty}
                <span style={{ color: T.textMuted, marginLeft: 10 }}>Day supply: {eOrder.transcribed.daySupply}</span>
                <span style={{ color: T.textMuted, marginLeft: 10 }}>Refills: {eOrder.transcribed.refills}</span>
              </span>
              <span style={{ color: "#5b8af5", fontWeight: 600 }}>Prescriber</span>
              <span>{eOrder.transcribed.prescriber}
                <span style={{ color: T.textMuted, marginLeft: 8 }}>DEA: {eOrder.transcribed.prescriberDEA}</span>
              </span>
              <span style={{ color: "#5b8af5", fontWeight: 600 }}>Written</span>
              <span>{eOrder.transcribed.dateWritten}</span>
            </div>
            {eOrder.transcribed.note && (
              <div style={{ marginTop: 6, padding: "5px 8px", borderRadius: 4, background: "#141a24", color: "#5b8af5", fontSize: 11 }}>
                <strong>Note:</strong> {eOrder.transcribed.note}
              </div>
            )}

            {/* Drug match confidence indicator */}
            {resolved && (
              <div style={{ marginTop: 8, display: "flex", gap: 10, fontSize: 10, fontWeight: 600 }}>
                {resolved.drug ? (
                  <span style={{
                    padding: "2px 8px", borderRadius: 3,
                    background: resolved.drug.confidence === "high" ? "#162018" : resolved.drug.confidence === "medium" ? "#1f1a14" : "#1f1418",
                    color: resolved.drug.confidence === "high" ? "#4abe6a" : resolved.drug.confidence === "medium" ? "#e8a030" : "#e45858",
                    border: `1px solid ${resolved.drug.confidence === "high" ? "#1a3d22" : resolved.drug.confidence === "medium" ? "#3d3020" : "#3d2228"}`,
                  }}>
                    Drug match: {resolved.drug.confidence} → {resolved.drug.drug.name} {resolved.drug.strength}
                  </span>
                ) : (
                  <span style={{ padding: "2px 8px", borderRadius: 3, background: "#1f1418", color: "#e45858", border: "1px solid #3d2228" }}>
                    Drug: no auto-match — manual selection needed
                  </span>
                )}
                {resolved.prescriber ? (
                  <span style={{
                    padding: "2px 8px", borderRadius: 3,
                    background: resolved.prescriber.confidence === "high" ? "#162018" : "#1f1a14",
                    color: resolved.prescriber.confidence === "high" ? "#4abe6a" : "#e8a030",
                    border: `1px solid ${resolved.prescriber.confidence === "high" ? "#1a3d22" : "#3d3020"}`,
                  }}>
                    Prescriber match: {resolved.prescriber.confidence}
                  </span>
                ) : (
                  <span style={{ padding: "2px 8px", borderRadius: 3, background: "#1f1418", color: "#e45858", border: "1px solid #3d2228" }}>
                    Prescriber: no auto-match
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Layer 2: Raw fielded data — collapsible */}
          <button
            onClick={() => setShowRawFields(!showRawFields)}
            style={{
              display: "flex", alignItems: "center", gap: 6, width: "100%",
              padding: "5px 10px", marginTop: 4, borderRadius: showRawFields ? "0" : "0 0 6px 6px",
              border: `1px solid ${T.surfaceBorder}`, borderTop: "none", background: T.surface,
              cursor: "pointer", fontSize: 10, color: T.textMuted,
              fontFamily: T.mono, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: 0.5,
            }}
          >
            <span style={{ transform: showRawFields ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s", display: "inline-block" }}>▸</span>
            Raw NCPDP Fields
          </button>
          {showRawFields && (
            <div style={{
              padding: "10px 12px", background: T.surface, border: `1px solid ${T.surfaceBorder}`,
              borderTop: "none", borderRadius: "0 0 6px 6px",
              fontFamily: T.mono, fontSize: 11, lineHeight: 1.6,
              maxHeight: 200, overflowY: "auto", color: T.textSecondary,
            }}>
              {Object.entries(eOrder.raw).map(([key, value]) => (
                <div key={key} style={{ display: "flex", gap: 8, borderBottom: "1px solid #e2e8f020", padding: "2px 0" }}>
                  <span style={{ color: T.textSecondary, minWidth: 160, flexShrink: 0, fontWeight: 600 }}>{key}</span>
                  <span style={{ color: T.textPrimary, wordBreak: "break-all" }}>{value || "—"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* No e-order — manual entry, show the original Rx text area */
        <>
          <button
            onClick={() => setShowOriginal(!showOriginal)}
            style={{
              display: "flex", alignItems: "center", gap: 6, width: "100%",
              padding: "6px 10px", borderRadius: 6, marginBottom: showOriginal ? 0 : 12,
              border: `1px solid ${T.surfaceBorder}`, background: T.surface, cursor: "pointer",
              fontSize: 11, color: T.textMuted, fontFamily: T.mono,
              fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5,
            }}
          >
            <span style={{ transform: showOriginal ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s", display: "inline-block" }}>▸</span>
            Original Rx / Ground Truth
          </button>
          {showOriginal && (
            <div style={{ marginBottom: 12 }}>
              <textarea
                value={origRxText}
                onChange={(e) => setOrigRxText(e.target.value)}
                placeholder="Paste or type the original prescription text here (e-script, fax, verbal order notes)..."
                rows={3}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: "0 0 6px 6px",
                  border: `1px solid ${T.surfaceBorder}`, borderTop: "none", background: T.surface,
                  color: T.textPrimary, fontSize: 12, fontFamily: T.mono,
                  outline: "none", resize: "vertical", boxSizing: "border-box", lineHeight: 1.5,
                }}
              />
            </div>
          )}
        </>
      )}

      {/* ── Drug + Strength + Form row ── */}
      <div style={{ display: "grid", gridTemplateColumns: drug ? "1fr auto auto" : "1fr", gap: 10, marginBottom: 10, alignItems: "start" }}>
        <div>
          {fieldLabel("Drug", true)}
          <InlineSearch
            placeholder="Search: name or name,strength,form..."
            onSearch={data.searchDrugs}
            onSelect={(d) => {
              if (d) {
                // If multi-field search matched a specific strength, auto-set it and skip the effect reset
                if (d._matchedStrength) {
                  skipNextStrengthReset.current = true;
                  setStrength(d._matchedStrength);
                }
                setDrug(d);
              } else {
                setDrug(null);
              }
            }}
            selected={drug}
            color={color}
            autoFocus
            renderItem={(d, hl) => (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 13, fontFamily: T.mono, color: hl ? color.text : "#1e293b" }}>
                    {d.name}
                  </span>
                  {d.brandNames[0] && (
                    <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 6 }}>({d.brandNames[0]})</span>
                  )}
                  {d._matchedStrength && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#5b8af5", marginLeft: 6, background: "#141a24", padding: "0 5px", borderRadius: 3 }}>
                      {d._matchedStrength}
                    </span>
                  )}
                  <div style={{ fontSize: 11, color: T.textSecondary, marginTop: 1 }}>
                    {d.drugClass}
                    <span style={{ color: "#cbd5e1", margin: "0 4px" }}>·</span>
                    {d.form}
                  </div>
                </div>
                {["C-II", "C-III", "C-IV", "C-V"].includes(d.schedule) && (
                  <span style={{
                    fontSize: 10, fontWeight: 800, color: "#e8a030",
                    background: "#1f1a14", border: "1px solid #3d3020",
                    padding: "1px 6px", borderRadius: 3, fontFamily: T.mono,
                  }}>
                    {d.schedule}
                  </span>
                )}
              </div>
            )}
            renderSelected={(d) => (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>{d.name}</span>
                {d.brandNames[0] && <span style={{ fontSize: 11, color: T.textMuted }}>({d.brandNames[0]})</span>}
                {["C-II", "C-III", "C-IV", "C-V"].includes(d.schedule) && (
                  <span style={{ fontSize: 9, fontWeight: 800, color: "#e8a030", background: "#1f1a14", border: "1px solid #3d3020", padding: "0 4px", borderRadius: 2 }}>
                    {d.schedule}
                  </span>
                )}
              </div>
            )}
          />
        </div>

        {/* Strength + Form (same row as drug when drug is selected) */}
        {drug && (
          <div style={{ minWidth: 100 }}>
            {fieldLabel("Strength", true)}
            <select
              value={strength}
              onChange={(e) => setStrength(e.target.value)}
              style={{
                width: "100%", padding: "8px 12px", borderRadius: T.radiusSm,
                border: `1px solid ${T.inputBorder}`, background: T.inputBg,
                color: strength ? T.textPrimary : T.textMuted, fontSize: 14, fontFamily: T.sans,
                outline: "none", boxSizing: "border-box", minHeight: 38, cursor: "pointer",
                appearance: "none",
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%235a6475'%3E%3Cpath d='M5 7L1 3h8z'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center",
                paddingRight: 28,
              }}
            >
              <option value="" disabled>Select</option>
              {drug.strengths.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        {drug && (
          <div style={{ minWidth: 90 }}>
            {fieldLabel("Form", false)}
            <input
              value={(() => {
                // Extract form from display strength: "25mg tablet" → "tablet"
                if (strength) {
                  const m = strength.match(/\d+(?:mg|mcg|ml)\s+(.+)$/i)
                    || strength.match(/\d+\/\d+(?:mg|ml)?\s+(.+)$/i);
                  if (m) return m[1];
                }
                return drug.form;
              })()}
              readOnly
              {...fieldInput({ style: { background: T.surface, color: T.textMuted } })}
            />
          </div>
        )}
      </div>

      {/* ── Product Selection ── */}
      {drug && strength && (
        <div style={{ marginBottom: 10 }}>
          {fieldLabel("Product (NDC)", true)}
          {product ? (
            <div
              tabIndex={0}
              onClick={() => setProduct(null)}
              onKeyDown={(e) => {
                if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); setProduct(null); }
              }}
              style={{
                width: "100%", padding: "7px 10px", borderRadius: 6,
                border: `1.5px solid ${color.border}60`, background: color.light,
                fontSize: 12, fontFamily: T.mono,
                display: "flex", alignItems: "center", justifyContent: "space-between",
                cursor: "pointer", color: T.textPrimary, minHeight: 36, boxSizing: "border-box",
                outline: "none",
              }}
            >
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 700 }}>{product.ndc}</span>
                <span style={{ color: T.textMuted, marginLeft: 8 }}>{product.manufacturer}</span>
                <span style={{ color: T.textSecondary, marginLeft: 8 }}>{product.packSize}ct</span>
                {!product.isGeneric && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: "#9b6ef0", background: "#1a1424", border: "1px solid #ddd6fe", padding: "0 4px", borderRadius: 2, marginLeft: 6 }}>BRAND</span>
                )}
              </div>
              <span onClick={(e) => { e.stopPropagation(); setProduct(null); }} style={{ color: T.textSecondary, cursor: "pointer", fontSize: 14, padding: "0 2px", marginLeft: 8 }}>×</span>
            </div>
          ) : (
            <div style={{
              border: `1px solid ${T.inputBorder}`, borderRadius: 6, background: T.surfaceRaised,
              maxHeight: 140, overflowY: "auto",
            }}>
              {availableProducts.length > 0 ? availableProducts.map(p => (
                <div key={p.id} onClick={() => setProduct(p)}
                  style={{
                    padding: "6px 10px", cursor: "pointer", fontSize: 12,
                    fontFamily: T.mono,
                    borderBottom: `1px solid ${T.surfaceBorder}`,
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    transition: "background 0.1s",
                  }}
                  onMouseOver={(e) => e.currentTarget.style.background = color.light}
                  onMouseOut={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 800, color: T.textPrimary, letterSpacing: "0.5px" }}>{p.ndc}</span>
                    <span style={{ color: T.textSecondary }}>{p.manufacturer}</span>
                    {!p.isGeneric && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: "#9b6ef0", background: "#1a1424", border: "1px solid #ddd6fe", padding: "0 4px", borderRadius: 2 }}>BRAND</span>
                    )}
                  </div>
                  <span style={{ color: T.textMuted, fontSize: 11, flexShrink: 0 }}>
                    {p.packSize > 0 ? `${p.packSize}ct` : ''}
                  </span>
                </div>
              )) : (
                <div style={{ padding: "10px 12px", color: T.textSecondary, fontSize: 12, fontStyle: "italic", textAlign: "center" }}>
                  No products on file for {drug.name} {strength}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Qty / Day Supply / Refills row ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div>
          {fieldLabel("Qty", true)}
          <input
            type="number"
            min="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="30"
            {...fieldInput()}
            onFocus={(e) => { e.target.style.borderColor = color.bg + "80"; }}
            onBlur={(e) => { e.target.style.borderColor = "#cbd5e1"; }}
          />
          {validationBadge("qty")}
        </div>
        <div>
          {fieldLabel("Day Supply", true)}
          <input
            type="number"
            min="1"
            value={daySupply}
            onChange={(e) => setDaySupply(e.target.value)}
            placeholder="30"
            {...fieldInput()}
            onFocus={(e) => { e.target.style.borderColor = color.bg + "80"; }}
            onBlur={(e) => { e.target.style.borderColor = "#cbd5e1"; }}
          />
          {validationBadge("daySupply")}
        </div>
        <div>
          {fieldLabel("Refills", false)}
          <input
            type="number"
            min="0"
            value={refills}
            onChange={(e) => setRefills(e.target.value)}
            placeholder="0"
            {...fieldInput()}
            onFocus={(e) => { e.target.style.borderColor = color.bg + "80"; }}
            onBlur={(e) => { e.target.style.borderColor = "#cbd5e1"; }}
          />
          {validationBadge("refills")}
        </div>
      </div>

      {/* ── SIG ── */}
      <div style={{ marginBottom: 10 }}>
        {fieldLabel("SIG (Directions)", true)}
        <textarea
          value={sig}
          onChange={(e) => setSig(e.target.value)}
          placeholder="Take 1 tablet by mouth once daily"
          rows={2}
          style={{
            width: "100%", padding: "7px 10px", borderRadius: 6,
            border: `1px solid ${T.inputBorder}`, background: T.surfaceRaised,
            color: T.textPrimary, fontSize: 13, fontFamily: T.mono,
            outline: "none", boxSizing: "border-box", resize: "vertical",
            lineHeight: 1.5, minHeight: 36, transition: "border-color 0.15s",
          }}
          onFocus={(e) => { e.target.style.borderColor = color.bg + "80"; }}
          onBlur={(e) => { e.target.style.borderColor = "#cbd5e1"; }}
        />
      </div>

      {/* ── DAW ── */}
      <div style={{ marginBottom: 14 }}>
        {fieldLabel("DAW Code", false)}
        <select
          value={daw}
          onChange={(e) => setDaw(parseInt(e.target.value, 10))}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: T.radiusSm,
            border: `1px solid ${T.inputBorder}`, background: T.inputBg,
            color: T.textPrimary, fontSize: 14, fontFamily: T.sans,
            outline: "none", boxSizing: "border-box", minHeight: 38, cursor: "pointer",
            appearance: "none",
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%235a6475'%3E%3Cpath d='M5 7L1 3h8z'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center",
            paddingRight: 28,
          }}
        >
          {DAW_CODES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </div>

      {/* ── Prescriber Search ── */}
      <div style={{ marginBottom: 10 }}>
        {fieldLabel("Prescriber", true)}
        <InlineSearch
          placeholder="Search by name, DEA, NPI..."
          onSearch={data.searchPrescribers}
          onSelect={setPrescriber}
          selected={prescriber}
          color={color}
          renderItem={(p, hl) => (
            <div>
              <span style={{ fontWeight: 700, fontSize: 13, fontFamily: T.mono, color: hl ? color.text : "#1e293b" }}>
                Dr. {p.lastName}, {p.firstName}
              </span>
              <span style={{ fontSize: 11, color: T.textSecondary, marginLeft: 6 }}>{p.credentials}</span>
              <div style={{ fontSize: 11, color: T.textSecondary, marginTop: 1 }}>
                {p.practice} · DEA: {p.dea}
              </div>
            </div>
          )}
          renderSelected={(p) => (
            <span>
              <span style={{ fontWeight: 700 }}>Dr. {p.lastName}, {p.firstName}</span>
              <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 6 }}>{p.credentials} · {p.practice}</span>
            </span>
          )}
        />
      </div>

      {/* ── Submit ── */}
      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: 8,
          border: "none", cursor: canSubmit ? "pointer" : "not-allowed",
          background: canSubmit ? color.bg : T.surface,
          color: canSubmit ? "#fff" : T.textMuted,
          fontSize: 13, fontWeight: 800, textTransform: "uppercase",
          letterSpacing: 1, fontFamily: T.mono,
          transition: "all 0.2s",
          boxShadow: canSubmit ? `0 4px 12px ${color.bg}40` : "none",
        }}
      >
        Submit Rx Entry
      </button>
    </div>
  );
}


// ============================================================
// PHARMACIST VERIFICATION COMPONENT
// ============================================================
function RphVerifyContent({ patient, workspace }) {
  const { dispatch, canDo } = useContext(PharmIDEContext);
  const color = workspace.color;
  const rxState = workspace.rxPrescription;

  const [checkedFields, setCheckedFields] = useState({});
  const [notes, setNotes] = useState("");

  // No Rx to verify
  if (!rxState) {
    return (
      <div style={{ padding: 20, textAlign: "center", color: T.textSecondary, fontFamily: T.mono, fontSize: 13 }}>
        
        <div style={{ fontWeight: 600 }}>No prescription pending verification</div>
        <div style={{ fontSize: 12, marginTop: 6, opacity: 0.6 }}>Submit an Rx from the Rx Entry tab first.</div>
      </div>
    );
  }

  // Already decided
  if (rxState.status === "approved" || rxState.status === "returned" || rxState.status === "call_prescriber") {
    const sc = {
      approved: { icon: "", label: "Approved", color: "#4abe6a", bg: "#162018", border: "#1a3d22" },
      returned: { icon: "", label: "Returned to Tech", color: "#e8a030", bg: "#1f1a14", border: "#3d3020" },
      call_prescriber: { icon: "", label: "Call Prescriber", color: "#e45858", bg: "#1f1418", border: "#3d2228" },
    }[rxState.status];
    return (
      <div style={{ padding: 16, fontFamily: T.sans, fontSize: 14, color: T.textPrimary }}>
        <div style={{
          padding: "16px 20px", borderRadius: 8, background: sc.bg, border: `1.5px solid ${sc.border}`,
          textAlign: "center",
        }}>
          
          <div style={{ fontWeight: 800, color: sc.color, fontSize: 14, textTransform: "uppercase", letterSpacing: 1 }}>
            {sc.label}
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>{rxState.rxNumber}</div>
          {rxState.rphReview?.notes && (
            <div style={{ marginTop: 10, fontSize: 12, color: T.textSecondary, textAlign: "left", padding: "8px 12px", background: T.surfaceRaised, borderRadius: 6, border: `1px solid ${T.surfaceBorder}` }}>
              <strong>Notes:</strong> {rxState.rphReview.notes}
            </div>
          )}
        </div>
      </div>
    );
  }

  const te = rxState.techEntry;
  const eOrder = rxState.eOrder;
  const orig = eOrder?.transcribed || {};

  // Field comparison data
  const fields = [
    { key: "drug", label: "Drug", original: orig.drug || "—", entered: `${te.drugName} ${te.strength}` },
    { key: "product", label: "Product / NDC", original: orig.drugNDC || "—", entered: `${te.productNdc} (${te.productManufacturer} ${te.productPackSize}ct)` },
    { key: "sig", label: "SIG", original: orig.sig || "—", entered: te.sig },
    { key: "qty", label: "Quantity", original: orig.qty != null ? String(orig.qty) : "—", entered: String(te.qty) },
    { key: "daySupply", label: "Day Supply", original: orig.daySupply != null ? String(orig.daySupply) : "—", entered: String(te.daySupply) },
    { key: "refills", label: "Refills", original: orig.refills != null ? String(orig.refills) : "—", entered: String(te.refills) },
    { key: "daw", label: "DAW", original: orig.daw != null ? String(orig.daw) : "—", entered: String(te.daw) },
    { key: "prescriber", label: "Prescriber", original: `${orig.prescriber || "—"}\nDEA: ${orig.prescriberDEA || "—"}`, entered: `${te.prescriberName}, ${te.prescriberCredentials}\nDEA: ${te.prescriberDEA}` },
  ];

  const toggleField = (key) => {
    setCheckedFields(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const allChecked = fields.every(f => checkedFields[f.key]);
  const checkedCount = fields.filter(f => checkedFields[f.key]).length;

  const handleDecision = (decision) => {
    dispatch({
      type: "RPH_DECISION", workspaceId: workspace.id,
      decision, notes,
      checkedFields: Object.keys(checkedFields).filter(k => checkedFields[k]),
    });
  };

  // Mismatch detection
  const detectMismatch = (field) => {
    if (!eOrder) return "none";
    const o = field.original.replace(/\s+/g, " ").trim().toLowerCase();
    const e = field.entered.replace(/\s+/g, " ").trim().toLowerCase();
    if (o === "—") return "none";
    if (["qty", "daySupply", "refills", "daw"].includes(field.key)) {
      return o === e ? "match" : "mismatch";
    }
    return (e.includes(o) || o.includes(e)) ? "match" : "mismatch";
  };

  // Desaturated accent — ~70% less vibrant, reserve bright for warnings
  const accent = T.textSecondary;
  const accentLight = T.surface;
  const accentBorder = T.surfaceBorder;

  return (
    <div style={{ padding: "16px 18px", fontFamily: T.sans, fontSize: 13 }}>
      {/* Header — desaturated */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 14, padding: "10px 14px", borderRadius: 8,
        background: accentLight, border: `1px solid ${accentBorder}`,
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 11, color: accent, textTransform: "uppercase", letterSpacing: 1, fontFamily: T.mono }}>
            Pharmacist Verification
          </div>
          <div style={{ fontSize: 11, color: "T.textSecondary", marginTop: 3, fontFamily: T.mono }}>
            {rxState.rxNumber} · {patient.name}
          </div>
        </div>
        <div style={{
          padding: "5px 12px", borderRadius: 4, fontSize: 11, fontWeight: 700,
          fontFamily: T.mono,
          background: allChecked ? "#162018" : accentLight,
          color: allChecked ? "#16a34a" : accent,
          border: `1px solid ${allChecked ? "#1a3d22" : T.surfaceBorder}`,
        }}>
          {checkedCount}/{fields.length} verified
        </div>
      </div>

      {/* Allergy banner — FULL bright, this is a warning */}
      {patient.allergies.length > 0 && (
        <div style={{
          padding: "9px 14px", borderRadius: 8, marginBottom: 14,
          background: "#1f1418", border: "1px solid #3d2228",
          fontSize: 12, color: "#e45858", fontWeight: 700,
          fontFamily: T.mono,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          
          ALLERGIES: {patient.allergies.join(" · ")}
        </div>
      )}

      {/* Active meds — desaturated */}
      {patient.medications.length > 0 && (
        <div style={{
          padding: "9px 14px", borderRadius: 8, marginBottom: 14,
          background: T.surface, border: `1px solid ${accentBorder}`,
          fontSize: 11, color: "#5a6a82", fontFamily: T.mono,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5, color: accent }}>
            Active Medications ({patient.medications.length})
          </div>
          {patient.medications.map((m, i) => (
            <div key={i} style={{ color: T.textSecondary, padding: "2px 0" }}>
              {m.name} — {m.directions}
            </div>
          ))}
        </div>
      )}

      {/* Comparison table — single header row */}
      <div style={{ marginBottom: 14, border: `1px solid ${accentBorder}`, borderRadius: 8, overflow: "hidden" }}>
        {/* Column header */}
        <div style={{
          display: "grid", gridTemplateColumns: "32px 100px 1fr 1fr",
          background: T.surface, borderBottom: `1px solid ${accentBorder}`,
          padding: "6px 0", fontFamily: T.mono,
          fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: "T.textSecondary",
        }}>
          <span></span>
          <span style={{ padding: "0 10px" }}>Field</span>
          <span style={{ padding: "0 10px" }}>Original</span>
          <span style={{ padding: "0 10px" }}>Entered</span>
        </div>

        {/* Rows */}
        {fields.map((field, idx) => {
          const checked = !!checkedFields[field.key];
          const status = detectMismatch(field);
          const isMatch = status === "match";
          const isMismatch = status === "mismatch";

          // Row colors: subtle dark tints
          const rowBg = checked ? "#162018"
            : isMismatch ? "#1f1a14"
            : isMatch ? "#141f18"
            : "transparent";
          const leftBorder = checked ? "#4abe6a60"
            : isMismatch ? "#e8a03060"
            : isMatch ? "#4abe6a30"
            : "transparent";

          return (
            <div
              key={field.key}
              onClick={() => toggleField(field.key)}
              style={{
                display: "grid", gridTemplateColumns: "32px 100px 1fr 1fr",
                cursor: "pointer", background: rowBg,
                borderBottom: idx < fields.length - 1 ? `1px solid ${T.surfaceBorder}` : "none",
                borderLeft: `3px solid ${leftBorder}`,
                transition: "all 0.12s ease", userSelect: "none",
              }}
            >
              {/* Checkbox */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 0" }}>
                <div style={{
                  width: 15, height: 15, borderRadius: 3,
                  border: `2px solid ${checked ? "#4abe6a" : T.surfaceBorder}`,
                  background: checked ? "#4abe6a" : T.inputBg,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.12s",
                }}>
                  {checked && <span style={{ color: "#fff", fontSize: 10, fontWeight: 800 }}>✓</span>}
                </div>
              </div>

              {/* Label */}
              <div style={{
                padding: "12px 10px", fontSize: 11, fontWeight: 600, color: accent,
                fontFamily: T.mono, display: "flex", alignItems: "center",
              }}>
                {field.label}
              </div>

              {/* Original */}
              <div style={{
                padding: "12px 10px", fontSize: 12, color: T.textSecondary,
                fontFamily: T.mono, whiteSpace: "pre-wrap", lineHeight: 1.5,
                borderLeft: `1px solid ${T.surfaceBorder}`,
              }}>
                {field.original}
              </div>

              {/* Entered */}
              <div style={{
                padding: "12px 10px", fontSize: 13, color: T.textPrimary, fontWeight: 500,
                fontFamily: T.mono, whiteSpace: "pre-wrap", lineHeight: 1.5,
                borderLeft: `1px solid ${T.surfaceBorder}`,
                position: "relative",
              }}>
                {field.entered}
                {isMismatch && !checked && (
                  <span style={{ fontSize: 9, color: "#e8a030", fontWeight: 700, marginLeft: 6 }}>VERIFY</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Notes — desaturated */}
      <div style={{ marginBottom: 14 }}>
        <label style={{
          display: "block", fontSize: 9, fontWeight: 700, color: accent,
          textTransform: "uppercase", letterSpacing: 1, marginBottom: 4,
          fontFamily: T.mono,
        }}>
          Pharmacist Notes
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Clinical notes, concerns, instructions for tech..."
          rows={2}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 6,
            border: `1.5px solid ${accentBorder}`, background: T.inputBg,
            color: T.textPrimary, fontSize: 12, fontFamily: T.mono,
            outline: "none", boxSizing: "border-box", resize: "vertical", lineHeight: 1.5,
          }}
          onFocus={(e) => { e.target.style.borderColor = accent + "80"; }}
          onBlur={(e) => { e.target.style.borderColor = accentBorder; }}
        />
      </div>

      {/* Decision buttons */}
      {canDo("RPH_DECISION") ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <button
            onClick={() => handleDecision("approve")}
            disabled={!allChecked}
            style={{
              padding: "10px 8px", borderRadius: 6, border: "none", cursor: allChecked ? "pointer" : "not-allowed",
              background: allChecked ? "#4abe6a" : T.surface,
              color: allChecked ? "#fff" : T.textMuted,
              fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
              fontFamily: T.mono, transition: "all 0.2s",
            }}
          >
            Approve
          </button>
          <button
            onClick={() => handleDecision("return")}
            style={{
              padding: "10px 8px", borderRadius: 6, border: `1.5px solid ${accentBorder}`,
              background: accentLight, color: accent, cursor: "pointer",
              fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
              fontFamily: T.mono,
            }}
          >
            Return
          </button>
          <button
            onClick={() => handleDecision("call_prescriber")}
            style={{
              padding: "10px 8px", borderRadius: 6, border: "1px solid #3d2228",
              background: "#1f1418", color: "#e45858", cursor: "pointer",
              fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
              fontFamily: T.mono,
            }}
          >
            Call Dr.
          </button>
        </div>
      ) : (
        <div style={{
          padding: "12px 16px", borderRadius: 8, background: T.surface,
          color: "T.textSecondary", fontSize: 12, textAlign: "center",
          fontFamily: T.mono, fontStyle: "italic",
        }}>
          Pharmacist verification required — tech view only
        </div>
      )}
    </div>
  );
}


// ============================================================
// FILL — Tech fills the prescription
// ============================================================
function FillContent({ patient, workspace }) {
  const data = useDataProvider();
  const { dispatch, canDo } = useContext(PharmIDEContext);
  const color = workspace.color;
  const rxState = workspace.rxPrescription;

  const [scannedNdc, setScannedNdc] = useState("");
  const [scanResult, setScanResult] = useState(null); // null | "match" | "mismatch"
  const [confirmedQty, setConfirmedQty] = useState("");
  const [scanInput, setScanInput] = useState(null);

  // Focus scan input on mount
  useEffect(() => {
    if (scanInput) scanInput.focus();
  }, [scanInput]);

  // ── Not ready to fill ──
  if (!rxState || (rxState.status !== "approved" && rxState.status !== "filling" && rxState.status !== "fill_review" && rxState.status !== "filled")) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: T.textMuted, fontFamily: T.mono }}>
        
        <div style={{ fontSize: 13 }}>
          {!rxState ? "No prescription entered yet" :
            rxState.status === "in_review" ? "Awaiting pharmacist verification" :
              rxState.status === "returned" ? "Rx returned — needs correction" :
                rxState.status === "call_prescriber" ? "Awaiting prescriber callback" :
                  "Not ready to fill"}
        </div>
      </div>
    );
  }

  const te = rxState.techEntry;
  const drug = data.getDrug(te.drugId);
  const expectedNdc = te.productNdc || "UNKNOWN";
  const isControl = te.schedule?.startsWith("C-");
  const needsQtyConfirm = isControl;

  // ── Start fill (transition from approved → filling) ──
  const handleStartFill = () => {
    if (canDo("START_FILL")) {
      dispatch({ type: "START_FILL", workspaceId: workspace.id });
    }
  };

  // ── NDC scan ──
  const handleScan = (value) => {
    const cleaned = value.replace(/[^0-9-]/g, "");
    setScannedNdc(cleaned);
    if (cleaned.length >= 10) {
      // Compare normalized (strip dashes)
      const normalScan = cleaned.replace(/-/g, "");
      const normalExpected = expectedNdc.replace(/-/g, "");
      setScanResult(normalScan === normalExpected ? "match" : "mismatch");
    } else {
      setScanResult(null);
    }
  };

  // ── Submit fill ──
  const canSubmitFill = scanResult === "match"
    && (!needsQtyConfirm || (confirmedQty && parseInt(confirmedQty, 10) > 0))
    && canDo("SUBMIT_FILL");

  const handleSubmitFill = () => {
    if (!canSubmitFill) return;
    dispatch({
      type: "SUBMIT_FILL", workspaceId: workspace.id,
      fillData: {
        scannedNdc: scannedNdc,
        expectedNdc,
        ndcMatch: true,
        confirmedQty: needsQtyConfirm ? parseInt(confirmedQty, 10) : parseInt(te.qty, 10),
        isControl,
      },
    });
  };

  // ── Already submitted for fill review ──
  if (rxState.status === "fill_review") {
    return (
      <div style={{ padding: 16, fontFamily: T.mono, color: T.textPrimary }}>
        <div style={{
          padding: "14px 18px", borderRadius: 10, marginBottom: 12,
          background: "#1f1a14",
          border: "1px solid #3d3020",
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#e8a030" }}>Awaiting Fill Verification</div>
          <div style={{ fontSize: 11, color: "#e8a030", marginTop: 4 }}>
            {rxState.rxNumber} · Filled {new Date(rxState.fillData.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
        <div style={{ padding: 14, borderRadius: 8, background: T.surface, border: `1px solid ${T.surfaceBorder}`, fontSize: 13, lineHeight: 1.8, color: T.textPrimary }}>
          <div><span style={{ color: T.textSecondary, display: "inline-block", width: 100 }}>Drug</span><strong>{te.drugName} {te.strength}</strong></div>
          <div><span style={{ color: T.textSecondary, display: "inline-block", width: 100 }}>NDC Scanned</span><span style={{ color: "#4abe6a" }}>✓ {rxState.fillData.scannedNdc}</span></div>
          <div><span style={{ color: T.textSecondary, display: "inline-block", width: 100 }}>Qty</span>{rxState.fillData.confirmedQty} {te.form}</div>
          {isControl && <div><span style={{ color: T.textMuted, display: "inline-block", width: 100 }}>Control</span><span style={{ color: "#e8a030" }}>{te.schedule} — qty double-checked</span></div>}
        </div>
      </div>
    );
  }

  // ── Already filled ──
  if (rxState.status === "filled") {
    return (
      <div style={{ padding: 16, fontFamily: T.mono, color: T.textPrimary }}>
        <div style={{
          padding: "14px 18px", borderRadius: 10,
          background: "#162018",
          border: "1px solid #1a3d22",
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#4abe6a" }}>Fill Complete — Ready for Pickup</div>
          <div style={{ fontSize: 11, color: "#4abe6a", marginTop: 4 }}>{rxState.rxNumber}</div>
        </div>
      </div>
    );
  }

  // ── Approved but not started filling ──
  if (rxState.status === "approved") {
    return (
      <div style={{ padding: 16, fontFamily: T.mono, textAlign: "center" }}>
        <div style={{
          padding: "14px 18px", borderRadius: 10, marginBottom: 16,
          background: "#162018",
          border: "1px solid #1a3d22",
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#4abe6a" }}>Rx Verified — Ready to Fill</div>
          <div style={{ fontSize: 11, color: "#4abe6a", marginTop: 4 }}>{rxState.rxNumber} · {te.drugName} {te.strength} · Qty: {te.qty}</div>
        </div>
        <button onClick={handleStartFill} disabled={!canDo("START_FILL")} style={{
          padding: "12px 32px", borderRadius: 8, border: "none",
          background: canDo("START_FILL") ? color.bg : T.surface,
          color: canDo("START_FILL") ? "#fff" : T.textMuted,
          fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1,
          fontFamily: T.mono, cursor: canDo("START_FILL") ? "pointer" : "not-allowed",
        }}>
          Begin Fill
        </button>
      </div>
    );
  }

  // ── Filling (active fill screen) ──
  return (
    <div style={{ padding: 16, fontFamily: T.mono, color: T.textPrimary }}>
      {/* Rx Summary Card */}
      <div style={{
        padding: 14, borderRadius: 10, marginBottom: 14,
        background: `${color.bg}10`, border: `1.5px solid ${color.bg}40`,
        fontSize: 12, lineHeight: 1.8,
      }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: color.bg, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
          Fill: {rxState.rxNumber}
        </div>
        <div><strong>{te.drugName} {te.strength}</strong></div>
        <div>SIG: {te.sig}</div>
        <div>Qty: <strong>{te.qty}</strong> · Day supply: {te.daySupply} · Refills: {te.refills}</div>
        {isControl && (
          <div style={{
            marginTop: 6, padding: "4px 10px", borderRadius: 4,
            background: "#1f1418", border: "1px solid #3d2228",
            color: "#e45858", fontSize: 11, fontWeight: 700,
          }}>
            CONTROLLED SUBSTANCE — {te.schedule}
          </div>
        )}
      </div>

      {/* NDC Scan */}
      <div style={{ marginBottom: 14 }}>
        <div style={{
          fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.2,
          color: color.bg, marginBottom: 6,
        }}>
          Scan NDC Barcode *
        </div>
        <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6 }}>
          Expected: <strong style={{ color: T.textPrimary }}>{expectedNdc}</strong>
        </div>
        <input
          ref={setScanInput}
          value={scannedNdc}
          onChange={(e) => handleScan(e.target.value)}
          placeholder="Scan or type NDC..."
          style={{
            width: "100%", padding: "10px 14px", borderRadius: 8, fontSize: 16,
            fontFamily: T.mono, fontWeight: 700, letterSpacing: 1,
            border: `2px solid ${scanResult === "match" ? "#4abe6a" : scanResult === "mismatch" ? "#e45858" : T.inputBorder}`,
            background: scanResult === "match" ? "#162018" : scanResult === "mismatch" ? "#1f1418" : T.inputBg,
            color: T.textPrimary, outline: "none", boxSizing: "border-box",
            transition: "all 0.2s",
          }}
        />
        {scanResult === "match" && (
          <div style={{ marginTop: 6, padding: "6px 12px", borderRadius: 6, background: "#162018", border: "1px solid #1a3d22", color: "#4abe6a", fontSize: 12, fontWeight: 700 }}>
            NDC Match — correct product
          </div>
        )}
        {scanResult === "mismatch" && (
          <div style={{ marginTop: 6, padding: "6px 12px", borderRadius: 6, background: "#1f1418", border: "1px solid #3d2228", color: "#e45858", fontSize: 12, fontWeight: 700 }}>
            NDC Mismatch — wrong product! Expected {expectedNdc}
          </div>
        )}
      </div>

      {/* Quantity Confirmation for Controls */}
      {needsQtyConfirm && scanResult === "match" && (
        <div style={{ marginBottom: 14 }}>
          <div style={{
            fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.2,
            color: "#e45858", marginBottom: 6,
          }}>
            Confirm Quantity Counted *
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6 }}>
            Prescribed qty: <strong style={{ color: T.textPrimary }}>{te.qty}</strong> — please count and confirm
          </div>
          <input
            value={confirmedQty}
            onChange={(e) => setConfirmedQty(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="Enter counted quantity..."
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 8, fontSize: 16,
              fontFamily: T.mono, fontWeight: 700,
              border: `2px solid #e4585840`, background: T.inputBg,
              color: T.textPrimary, outline: "none", boxSizing: "border-box",
            }}
          />
          {confirmedQty && parseInt(confirmedQty, 10) !== parseInt(te.qty, 10) && (
            <div style={{ marginTop: 6, padding: "6px 12px", borderRadius: 6, background: "#1f1a14", border: "1px solid #3d3020", color: "#e8a030", fontSize: 11, fontWeight: 700 }}>
              Counted qty ({confirmedQty}) differs from prescribed qty ({te.qty})
            </div>
          )}
        </div>
      )}

      {/* Submit Fill */}
      <button onClick={handleSubmitFill} disabled={!canSubmitFill} style={{
        width: "100%", padding: "12px 16px", borderRadius: T.radiusSm, border: "none",
        background: canSubmitFill ? color.bg : T.surface,
        color: canSubmitFill ? "#fff" : T.textMuted,
        fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1,
        fontFamily: T.mono,
        cursor: canSubmitFill ? "pointer" : "not-allowed",
        transition: "all 0.2s",
      }}>
        Submit Fill for Verification
      </button>
    </div>
  );
}


// ============================================================
// FILL VERIFY — RPh verifies the fill
// ============================================================
function FillVerifyContent({ patient, workspace }) {
  const data = useDataProvider();
  const { dispatch, canDo } = useContext(PharmIDEContext);
  const color = workspace.color;
  const rxState = workspace.rxPrescription;

  const [notes, setNotes] = useState("");
  const [checks, setChecks] = useState({ product: false, qty: false, rxInfo: false });

  // ── Not ready ──
  if (!rxState || !["fill_review", "filled"].includes(rxState.status)) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: T.textMuted, fontFamily: T.mono }}>
        
        <div style={{ fontSize: 13 }}>
          {!rxState ? "No prescription to verify" :
            rxState.status === "filling" ? "Tech is filling — not yet submitted" :
              "Fill not ready for verification"}
        </div>
      </div>
    );
  }

  const te = rxState.techEntry;
  const fd = rxState.fillData;
  const drug = data.getDrug(te.drugId);
  const isControl = te.schedule?.startsWith("C-");
  const allChecked = Object.values(checks).every(Boolean);

  const handleDecision = (decision) => {
    if (!canDo("RPH_FILL_DECISION")) return;
    dispatch({
      type: "RPH_FILL_DECISION", workspaceId: workspace.id,
      decision, notes,
    });
  };

  // ── Already decided ──
  if (rxState.status === "filled") {
    const review = rxState.rphFillReview;
    return (
      <div style={{ padding: 16, fontFamily: T.mono, color: T.textPrimary }}>
        <div style={{
          padding: "14px 18px", borderRadius: 10,
          background: "#162018",
          border: "1px solid #1a3d22",
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#4abe6a" }}>Fill Verified — Ready for Pickup</div>
          <div style={{ fontSize: 11, color: "#4abe6a", marginTop: 4 }}>
            {rxState.rxNumber} · Verified {review?.decidedAt ? new Date(review.decidedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
          </div>
        </div>
        {review?.notes && (
          <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 8, background: "#1a1424", border: "1px solid #302250", fontSize: 12, color: "#9b6ef0" }}>
            <strong style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>RPh Notes:</strong>
            <div style={{ marginTop: 4 }}>{review.notes}</div>
          </div>
        )}
      </div>
    );
  }

  // ── Fill review ──
  return (
    <div style={{ padding: 16, fontFamily: T.mono, color: T.textPrimary }}>
      {/* Header */}
      <div style={{
        padding: "10px 14px", borderRadius: 8, marginBottom: 12,
        background: `${color.bg}15`, border: `1.5px solid ${color.bg}40`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: color.bg }}>Fill Verification</div>
          <div style={{ fontSize: 11, color: T.textMuted }}>{rxState.rxNumber} · {patient.name}</div>
        </div>
        <div style={{ fontSize: 11, color: T.textMuted }}>
          {Object.values(checks).filter(Boolean).length}/{Object.keys(checks).length} checked
        </div>
      </div>

      {/* Allergy Banner */}
      {patient.allergies?.length > 0 && (
        <div style={{
          padding: "8px 14px", borderRadius: 8, marginBottom: 12,
          background: "#1f1418", border: "1px solid #3d2228",
          color: "#e45858", fontSize: 11, fontWeight: 700,
        }}>
          ALLERGIES: {patient.allergies.join(" · ")}
        </div>
      )}

      {/* Rx Info Summary */}
      <div style={{
        padding: 12, borderRadius: 8, marginBottom: 12,
        background: T.surface, border: `1px solid ${T.surfaceBorder}`,
        fontSize: 13, lineHeight: 1.8, color: T.textPrimary,
      }}>
        <div><span style={{ color: T.textSecondary, display: "inline-block", width: 90 }}>Drug</span><strong>{te.drugName} {te.strength}</strong></div>
        <div><span style={{ color: T.textSecondary, display: "inline-block", width: 90 }}>SIG</span>{te.sig}</div>
        <div><span style={{ color: T.textSecondary, display: "inline-block", width: 90 }}>Qty</span>{te.qty} · Day supply: {te.daySupply}</div>
        <div><span style={{ color: T.textSecondary, display: "inline-block", width: 90 }}>Prescriber</span>{te.prescriberName}</div>
        <div><span style={{ color: T.textSecondary, display: "inline-block", width: 90 }}>NDC</span><span style={{ color: "#4abe6a" }}>✓ {fd.scannedNdc}</span></div>
        {isControl && (
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>Control</span><span style={{ color: "#e45858", fontWeight: 700 }}>{te.schedule} — Counted: {fd.confirmedQty}</span></div>
        )}
      </div>

      {/* Verification Checklist */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.2, color: color.bg, marginBottom: 8 }}>
          Verification Checklist
        </div>
        {[
          { key: "product", label: "Product appears correct (visual check)" },
          { key: "qty", label: isControl ? `Quantity verified: ${fd.confirmedQty} ${te.form}s (controlled)` : `Quantity appears correct: ${te.qty} ${te.form}s` },
          { key: "rxInfo", label: "Rx information reviewed and appropriate" },
        ].map(item => (
          <div key={item.key}
            onClick={() => setChecks(prev => ({ ...prev, [item.key]: !prev[item.key] }))}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
              borderRadius: T.radiusSm, marginBottom: 4, cursor: "pointer",
              border: `1px solid ${checks[item.key] ? "#1a3d22" : T.surfaceBorder}`,
              background: checks[item.key] ? "#162018" : "transparent",
              transition: "all 0.15s",
            }}
          >
            <div style={{
              width: 20, height: 20, borderRadius: 4, flexShrink: 0,
              border: `2px solid ${checks[item.key] ? "#4abe6a" : T.surfaceBorder}`,
              background: checks[item.key] ? "#4abe6a" : T.inputBg,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontSize: 12, fontWeight: 800,
            }}>
              {checks[item.key] ? "✓" : ""}
            </div>
            <span style={{ fontSize: 13, color: checks[item.key] ? "#4abe6a" : T.textSecondary }}>{item.label}</span>
          </div>
        ))}
      </div>

      {/* Notes */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.2, color: T.textMuted, marginBottom: 6 }}>
          Pharmacist Notes
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes..."
          rows={2}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 12,
            fontFamily: T.mono, border: `1px solid ${T.inputBorder}`,
            background: T.surfaceRaised, color: T.textPrimary, outline: "none", boxSizing: "border-box",
            resize: "vertical",
          }}
        />
      </div>

      {/* Decision Buttons */}
      {canDo("RPH_FILL_DECISION") ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button onClick={() => handleDecision("approve")} disabled={!allChecked} style={{
            padding: "10px 8px", borderRadius: 8, border: "none",
            cursor: allChecked ? "pointer" : "not-allowed",
            background: allChecked ? "#4abe6a" : T.surface,
            color: allChecked ? "#fff" : T.textMuted,
            fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
            fontFamily: T.mono, transition: "all 0.2s",
            boxShadow: allChecked ? "0 4px 12px #16a34a40" : "none",
          }}>
            Approve Fill
          </button>
          <button onClick={() => handleDecision("refill")} style={{
            padding: "10px 8px", borderRadius: 8, border: "1px solid #3d2228",
            background: "#1f1418", color: "#e45858", cursor: "pointer",
            fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
            fontFamily: T.mono,
          }}>
            Reject — Refill
          </button>
        </div>
      ) : (
        <div style={{
          padding: "12px 16px", borderRadius: 8, background: "#1e293b",
          color: T.textMuted, fontSize: 12, textAlign: "center",
          fontFamily: T.mono, fontStyle: "italic",
        }}>
          Pharmacist verification required — tech view only
        </div>
      )}
    </div>
  );
}


// ============================================================
// DATA ENTRY WORKSPACE — Task-focused throughput workspace
// ============================================================
function DataEntryWorkspaceContent({ workspace }) {
  const data = useDataProvider();
  const { dispatch, canDo, state } = useContext(PharmIDEContext);
  const color = workspace.color;

  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [activeRx, setActiveRx] = useState(false); // false = queue view, true = entry view

  // Get all e-orders and figure out which are already being worked on
  const allEOrders = useMemo(() => data.getAllEOrders(), [data]);
  const processedPatientIds = useMemo(() => {
    return new Set(
      Object.values(state.workspaces)
        .filter(ws => ws.patientId && ws.rxPrescription)
        .map(ws => ws.patientId)
    );
  }, [state.workspaces]);

  const pendingEOrders = useMemo(() => {
    return allEOrders.filter(eo => !processedPatientIds.has(eo.patientId));
  }, [allEOrders, processedPatientIds]);

  const selectedPatient = selectedPatientId ? MOCK_PATIENTS.find(p => p.id === selectedPatientId) : null;
  const selectedEOrder = selectedPatientId ? data.getEOrder(selectedPatientId) : null;

  // Check if patient has other active work
  const patientActiveWork = useMemo(() => {
    if (!selectedPatientId) return [];
    return Object.values(state.workspaces)
      .filter(ws => ws.patientId === selectedPatientId && ws.rxPrescription)
      .map(ws => ws.rxPrescription);
  }, [selectedPatientId, state.workspaces]);

  // Handle opening an Rx for entry — create a patient workspace in the background
  const handleOpenRx = () => {
    if (!selectedPatientId) return;
    dispatch({ type: "CREATE_WORKSPACE", patientId: selectedPatientId });
    setActiveRx(true);
  };

  // Handle finishing and going back to queue
  const handleBackToQueue = () => {
    setActiveRx(false);
    setSelectedPatientId(null);
  };

  // Get the patient workspace if it exists (for the embedded entry form)
  const patientWorkspace = useMemo(() => {
    return Object.values(state.workspaces).find(ws => ws.patientId === selectedPatientId);
  }, [selectedPatientId, state.workspaces]);

  // If actively entering, show embedded entry form + context panel
  if (activeRx && selectedPatient && patientWorkspace) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 0, height: "100%", overflow: "hidden" }}>
        {/* Left: Rx Entry Form */}
        <div style={{ overflow: "auto", padding: 2, borderRight: "1px solid #e2e8f0" }}>
          {/* Back button + patient header */}
          <div style={{
            padding: "8px 14px", display: "flex", alignItems: "center", justifyContent: "space-between",
            borderBottom: `1px solid ${T.surfaceBorder}`, marginBottom: 2,
          }}>
            <button onClick={handleBackToQueue} style={{
              background: "none", border: `1px solid ${T.inputBorder}`, borderRadius: 6,
              padding: "4px 12px", fontSize: 11, color: T.textMuted, cursor: "pointer",
              fontFamily: T.mono, fontWeight: 600,
            }}>
              ← Queue
            </button>
            <div style={{ fontSize: 12, fontWeight: 700, color: color.bg }}>
              {selectedPatient.name}
              <span style={{ fontWeight: 400, color: T.textMuted, marginLeft: 8, fontSize: 11 }}>DOB: {selectedPatient.dob}</span>
            </div>
          </div>
          <RxEntryContent patient={selectedPatient} workspace={patientWorkspace} />
        </div>

        {/* Right: Mini-tile context panel */}
        <div style={{
          overflow: "auto", background: T.surface,
          fontFamily: T.mono, fontSize: 12,
        }}>
          <div style={{
            padding: "8px 12px", borderBottom: `1px solid ${T.surfaceBorder}`,
            fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1,
            color: T.textMuted,
          }}>
            Patient Context
          </div>

          {/* Allergies */}
          {selectedPatient.allergies?.length > 0 && (
            <MiniCard title="Allergies" color="#dc2626">
              <div style={{ color: "#e45858", fontWeight: 700 }}>
                {selectedPatient.allergies.join(" · ")}
              </div>
            </MiniCard>
          )}

          {/* Current Meds */}
          <MiniCard title="Current Medications" color="#3b82f6">
            {selectedPatient.medications?.length > 0 ? selectedPatient.medications.map((med, i) => (
              <div key={i} style={{ marginBottom: 4, lineHeight: 1.4 }}>
                <div style={{ fontWeight: 600, color: T.textPrimary, fontSize: 11 }}>{med.name}</div>
                <div style={{ color: T.textMuted, fontSize: 10 }}>{med.directions}</div>
              </div>
            )) : <div style={{ color: T.textSecondary, fontStyle: "italic" }}>No medications on file</div>}
          </MiniCard>

          {/* Insurance */}
          <MiniCard title="Insurance" color="#10b981">
            <div style={{ lineHeight: 1.6, fontSize: 11 }}>
              <div><strong>{selectedPatient.insurance?.plan}</strong></div>
              <div style={{ color: T.textMuted }}>ID: {selectedPatient.insurance?.memberId}</div>
              <div style={{ color: T.textMuted }}>Copay: {selectedPatient.insurance?.copay}</div>
            </div>
          </MiniCard>

          {/* Notes */}
          {selectedPatient.notes && (
            <MiniCard title="Notes" color="#f59e0b">
              <div style={{ color: T.textSecondary, lineHeight: 1.5, fontSize: 11 }}>{selectedPatient.notes}</div>
            </MiniCard>
          )}

          {/* Active Work */}
          {patientActiveWork.length > 0 && (
            <MiniCard title="Active Rxs" color="#8b5cf6">
              {patientActiveWork.map((rx, i) => (
                <div key={i} style={{ marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: T.textPrimary }}>{rx.techEntry?.drugName} {rx.techEntry?.strength}</span>
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4,
                    background: rx.status === "approved" ? "#162018" : rx.status === "in_review" ? "#1f1a14" : T.surface,
                    color: rx.status === "approved" ? "#16a34a" : rx.status === "in_review" ? "#d97706" : "#64748b",
                  }}>
                    {rx.status}
                  </span>
                </div>
              ))}
            </MiniCard>
          )}
        </div>
      </div>
    );
  }

  // Queue view — list of pending e-orders + preview panel
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 0, height: "100%", overflow: "hidden" }}>
      {/* Left: Queue list */}
      <div style={{ overflow: "auto", fontFamily: T.mono }}>
        <div style={{
          padding: "10px 14px", borderBottom: `1px solid ${T.surfaceBorder}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <span style={{ fontSize: 14, fontWeight: 800, color: color.bg }}>Data Entry Queue</span>
            <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 10 }}>{pendingEOrders.length} pending</span>
          </div>
        </div>

        {pendingEOrders.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textSecondary }}>
            
            <div style={{ fontSize: 13 }}>Queue is clear — all caught up!</div>
          </div>
        ) : (
          <div>
            {pendingEOrders.map((eo) => {
              const isSelected = selectedPatientId === eo.patientId;
              const hasActiveWork = Object.values(state.workspaces).some(ws => ws.patientId === eo.patientId && ws.rxPrescription);
              const age = Math.floor((Date.now() - new Date(eo.receivedAt).getTime()) / 60000);
              const resolved = data.resolveEOrder(eo);
              return (
                <div
                  key={eo.messageId}
                  onClick={() => setSelectedPatientId(eo.patientId)}
                  style={{
                    padding: "10px 14px", cursor: "pointer",
                    borderBottom: `1px solid ${T.surfaceBorder}`,
                    borderLeft: isSelected ? `3px solid ${color.bg}` : "3px solid transparent",
                    background: isSelected ? `${color.bg}08` : "transparent",
                    transition: "all 0.1s",
                  }}
                  onMouseOver={(e) => { if (!isSelected) e.currentTarget.style.background = "#fafafa"; }}
                  onMouseOut={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: T.textPrimary }}>
                        {eo.transcribed.drug}
                      </div>
                      <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                        {eo.patient.name}
                        <span style={{ color: "#cbd5e1", margin: "0 4px" }}>·</span>
                        {eo.transcribed.prescriber}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <span style={{
                        fontSize: 9, color: age > 30 ? "#dc2626" : age > 15 ? "#d97706" : "#64748b",
                        fontWeight: age > 15 ? 700 : 400,
                      }}>
                        {age}m ago
                      </span>
                      {resolved?.drug?.confidence && (
                        <span style={{
                          fontSize: 8, padding: "1px 5px", borderRadius: 3,
                          background: resolved.drug.confidence === "high" ? "#162018" : "#1f1a14",
                          color: resolved.drug.confidence === "high" ? "#16a34a" : "#d97706",
                          fontWeight: 700,
                        }}>
                          {resolved.drug.confidence} match
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Flags row */}
                  <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                    {hasActiveWork && (
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#1a1424", color: "#9b6ef0", border: "1px solid #ddd6fe" }}>
                        HAS ACTIVE RX
                      </span>
                    )}
                    {eo.patient.allergies?.length > 0 && (
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#1f1418", color: "#e45858", border: "1px solid #3d2228" }}>
                        ALLERGIES
                      </span>
                    )}
                    {eo.transcribed.note && (
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#1f1a14", color: "#e8a030", border: "1px solid #3d3020" }}>
                        HAS NOTE
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Right: Preview panel */}
      <div style={{
        overflow: "auto", background: T.surface, borderLeft: `1px solid ${T.surfaceBorder}`,
        fontFamily: T.mono,
      }}>
        {selectedPatient && selectedEOrder ? (
          <>
            {/* Patient header */}
            <div style={{
              padding: "10px 12px", borderBottom: `1px solid ${T.surfaceBorder}`,
              background: T.surfaceRaised,
            }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.textPrimary }}>{selectedPatient.name}</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                DOB: {selectedPatient.dob} · {selectedPatient.phone}
              </div>
            </div>

            {/* Allergies - safety gate, always visible */}
            {selectedPatient.allergies?.length > 0 && (
              <MiniCard title="Allergies" color="#dc2626">
                <div style={{ color: "#e45858", fontWeight: 700 }}>
                  {selectedPatient.allergies.join(" · ")}
                </div>
              </MiniCard>
            )}

            {/* OPERATIONAL: What's happening with this patient RIGHT NOW */}
            {(() => {
              const statusConfig = {
                in_review: { label: "RPh Review", bg: "#1f1a14", fg: "#d97706", icon: "" },
                approved: { label: "Ready to Fill", bg: "#162018", fg: "#4abe6a", icon: "" },
                filling: { label: "Filling", bg: "#141a24", fg: "#5b8af5", icon: "" },
                fill_review: { label: "Fill Check", bg: "#1a1424", fg: "#9b6ef0", icon: "" },
                filled: { label: "Pickup", bg: "#162018", fg: "#4abe6a", icon: "" },
                returned: { label: "Returned", bg: "#1f1418", fg: "#dc2626", icon: "↩" },
                call_prescriber: { label: "Call Dr", bg: "#fff7ed", fg: "#ea580c", icon: "📞" },
              };
              return patientActiveWork.length > 0 ? (
                <MiniCard title={`In System · ${patientActiveWork.length} Active`} color="#8b5cf6">
                  {patientActiveWork.map((rx, i) => {
                    const sc = statusConfig[rx.status] || { label: rx.status || "new", bg: "#f1f5f9", fg: "#64748b", icon: "·" };
                    const ageMin = rx.techEntry?.submittedAt ? Math.round((Date.now() - rx.techEntry.submittedAt) / 60000) : null;
                    return (
                      <div key={i} style={{
                        marginBottom: 6, padding: "6px 8px", borderRadius: 6,
                        background: sc.bg, border: `1px solid ${sc.fg}30`,
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: T.textPrimary }}>
                            {rx.techEntry?.drugName} {rx.techEntry?.strength}
                          </span>
                          <span style={{
                            fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                            background: `${sc.fg}20`, color: sc.fg,
                            fontFamily: T.mono,
                          }}>
                            {sc.icon} {sc.label}
                          </span>
                        </div>
                        <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2, display: "flex", gap: 8 }}>
                          {rx.rxNumber && <span>Rx# {rx.rxNumber}</span>}
                          {ageMin != null && (
                            <span style={{ color: ageMin > 30 ? "#dc2626" : ageMin > 15 ? "#d97706" : "#64748b" }}>
                              {ageMin}m ago
                            </span>
                          )}
                          {rx.techEntry?.prescriberName && <span>Dr: {rx.techEntry.prescriberName}</span>}
                        </div>
                      </div>
                    );
                  })}
                </MiniCard>
              ) : (
                <div style={{
                  margin: "0 12px", padding: "8px 12px", borderRadius: 6,
                  background: T.surface, border: `1px solid ${T.surfaceBorder}`,
                  fontSize: 11, color: T.textSecondary, textAlign: "center",
                  fontFamily: T.mono,
                }}>
                  No active scripts in system
                </div>
              );
            })()}

            {/* E-Order Preview - what you're about to work on */}
            <MiniCard title="Incoming E-Script" color={color.bg}>
              <div style={{ lineHeight: 1.6, fontSize: 11 }}>
                <div><strong>{selectedEOrder.transcribed.drug}</strong></div>
                <div style={{ color: T.textMuted }}>SIG: {selectedEOrder.transcribed.sig}</div>
                <div style={{ color: T.textMuted }}>Qty: {selectedEOrder.transcribed.qty} · DS: {selectedEOrder.transcribed.daySupply} · Refills: {selectedEOrder.transcribed.refills}</div>
                <div style={{ color: T.textMuted }}>Dr: {selectedEOrder.transcribed.prescriber}</div>
                {selectedEOrder.transcribed.note && (
                  <div style={{ marginTop: 4, padding: "4px 8px", borderRadius: 4, background: "#1f1a14", color: "#e8a030", fontSize: 10, fontWeight: 600 }}>
                    Note: {selectedEOrder.transcribed.note}
                  </div>
                )}
              </div>
            </MiniCard>

            {/* Insurance - need for adjudication */}
            <MiniCard title="Insurance" color="#10b981">
              <div style={{ lineHeight: 1.6, fontSize: 11 }}>
                <div><strong>{selectedPatient.insurance?.plan}</strong></div>
                <div style={{ color: T.textMuted }}>ID: {selectedPatient.insurance?.memberId}</div>
                <div style={{ color: T.textMuted }}>Copay: {selectedPatient.insurance?.copay}</div>
              </div>
            </MiniCard>

            {/* Notes - operational flags */}
            {selectedPatient.notes && (
              <MiniCard title="Notes" color="#f59e0b">
                <div style={{ color: T.textSecondary, lineHeight: 1.5, fontSize: 11 }}>{selectedPatient.notes}</div>
              </MiniCard>
            )}

            {/* Current Meds - collapsed, clinical reference only */}
            <details style={{ margin: "0 12px 8px" }}>
              <summary style={{
                fontSize: 10, fontWeight: 700, color: T.textSecondary, cursor: "pointer",
                padding: "6px 0", textTransform: "uppercase", letterSpacing: 0.5,
                fontFamily: T.mono,
              }}>
                Med History ({selectedPatient.medications?.length || 0})
              </summary>
              <div style={{ padding: "4px 0" }}>
                {selectedPatient.medications?.length > 0 ? selectedPatient.medications.map((med, i) => (
                  <div key={i} style={{ marginBottom: 3, lineHeight: 1.3 }}>
                    <span style={{ fontWeight: 600, color: T.textSecondary, fontSize: 10 }}>{med.name}</span>
                    <span style={{ color: T.textSecondary, fontSize: 10 }}> — {med.directions}</span>
                  </div>
                )) : <div style={{ color: T.textSecondary, fontStyle: "italic", fontSize: 10 }}>None on file</div>}
              </div>
            </details>

            {/* Open button */}
            <div style={{ padding: "12px 12px" }}>
              <button onClick={handleOpenRx} style={{
                width: "100%", padding: "10px 16px", borderRadius: 8, border: "none",
                background: `linear-gradient(135deg, ${color.bg}, ${color.bg}dd)`,
                color: "#fff", fontSize: 12, fontWeight: 800, textTransform: "uppercase",
                letterSpacing: 1, fontFamily: T.mono, cursor: "pointer",
                boxShadow: `0 4px 12px ${color.bg}40`,
              }}>
                Open for Entry
              </button>
            </div>
          </>
        ) : (
          <div style={{ padding: 40, textAlign: "center", color: T.textSecondary }}>
            <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.3 }}>👈</div>
            <div style={{ fontSize: 12 }}>Select an e-script to preview</div>
          </div>
        )}
      </div>
    </div>
  );
}

// Mini card component for context panel
function MiniCard({ title, color, children }) {
  return (
    <div style={{ padding: "8px 12px", borderBottom: `1px solid ${T.surfaceBorder}` }}>
      <div style={{
        fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1,
        color: color, marginBottom: 4,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}


// ============================================================
// OTHER TAB CONTENT COMPONENTS (preserved from prototype)
// ============================================================
function PatientProfileContent({ patient, workspace }) {
  return (
    <div style={{ padding: 16, fontFamily: T.mono, fontSize: 13 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 12, marginBottom: 16,
        padding: "12px 16px", background: workspace.color.light, borderRadius: 8,
        border: `1px solid ${workspace.color.border}40`
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: "50%", background: workspace.color.bg,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontSize: 20, fontWeight: 700,
        }}>
          {patient.name.split(" ").map(n => n[0]).join("")}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{patient.name}</div>
          <div style={{ color: T.textMuted, fontSize: 12 }}>DOB: {patient.dob}</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "6px 12px" }}>
        <span style={{ color: T.textMuted, fontWeight: 600 }}>Phone</span>
        <span>{patient.phone}</span>
        <span style={{ color: T.textMuted, fontWeight: 600 }}>Address</span>
        <span>{patient.address}</span>
      </div>
      {patient.notes && (
        <div style={{
          marginTop: 14, padding: "10px 14px", borderRadius: 8,
          background: "#1f1a14", border: "1px solid #3d3020",
          fontSize: 12, color: "#e8a030", lineHeight: 1.5,
        }}>
          <strong>Notes:</strong> {patient.notes}
        </div>
      )}
    </div>
  );
}

function MedHistoryContent({ patient, workspace }) {
  return (
    <div style={{ padding: 16, fontFamily: T.mono, fontSize: 13 }}>
      <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 }}>
        Active Medications ({patient.medications.length})
      </div>
      {patient.medications.map((med, i) => (
        <div key={i} style={{
          padding: "10px 14px", marginBottom: 8, borderRadius: 8,
          background: workspace.color.light, border: `1px solid ${workspace.color.border}30`,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{med.name}</div>
          <div style={{ fontSize: 12, color: T.textMuted }}>{med.directions}</div>
          <div style={{ fontSize: 11, color: T.textSecondary, marginTop: 4, display: "flex", gap: 12 }}>
            <span>Qty: {med.qty}</span>
            <span>Refills: {med.refills}</span>
            <span>Last fill: {med.lastFill}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function InsuranceContent({ patient, workspace }) {
  const ins = patient.insurance;
  return (
    <div style={{ padding: 16, fontFamily: T.mono, fontSize: 13 }}>
      <div style={{
        padding: 16, borderRadius: 8, background: workspace.color.light,
        border: `1px solid ${workspace.color.border}40`,
      }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>{ins.plan}</div>
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "6px 12px" }}>
          <span style={{ color: T.textMuted, fontWeight: 600 }}>Member ID</span>
          <span style={{ fontFamily: T.mono }}>{ins.memberId}</span>
          <span style={{ color: T.textMuted, fontWeight: 600 }}>Group</span>
          <span>{ins.group}</span>
          <span style={{ color: T.textMuted, fontWeight: 600 }}>Copay</span>
          <span>{ins.copay}</span>
        </div>
      </div>
    </div>
  );
}

function AllergiesContent({ patient, workspace }) {
  return (
    <div style={{ padding: 16, fontFamily: T.mono, fontSize: 13 }}>
      {patient.allergies.length === 0 ? (
        <div style={{ color: "#4abe6a", fontWeight: 600 }}>No known allergies</div>
      ) : (
        patient.allergies.map((a, i) => (
          <div key={i} style={{
            padding: "10px 14px", marginBottom: 8, borderRadius: 8,
            background: "#1f1418", border: "1px solid #3d2228",
            color: "#e45858", fontWeight: 600, display: "flex", alignItems: "center", gap: 8,
          }}>
            {a}
          </div>
        ))
      )}
    </div>
  );
}

function NotesContent({ patient }) {
  return (
    <div style={{ padding: 16, fontFamily: T.mono, fontSize: 13 }}>
      <div style={{
        padding: 14, borderRadius: 8, background: T.surface,
        border: `1px solid ${T.surfaceBorder}`, lineHeight: 1.6,
        minHeight: 100, whiteSpace: "pre-wrap",
      }}>
        {patient.notes || "No notes for this patient."}
      </div>
    </div>
  );
}

function TabContent({ tab, patient, workspace }) {
  switch (tab.type) {
    case "RX_ENTRY": return <RxEntryContent patient={patient} workspace={workspace} />;
    case "RPH_VERIFY": return <RphVerifyContent patient={patient} workspace={workspace} />;
    case "FILL": return <FillContent patient={patient} workspace={workspace} />;
    case "FILL_VERIFY": return <FillVerifyContent patient={patient} workspace={workspace} />;
    case "DATA_ENTRY_WS": return <DataEntryWorkspaceContent workspace={workspace} />;
    case "PATIENT_PROFILE": return <PatientProfileContent patient={patient} workspace={workspace} />;
    case "MED_HISTORY": return <MedHistoryContent patient={patient} workspace={workspace} />;
    case "INSURANCE": return <InsuranceContent patient={patient} workspace={workspace} />;
    case "ALLERGIES": return <AllergiesContent patient={patient} workspace={workspace} />;
    case "NOTES": return <NotesContent patient={patient} />;
    case "INVENTORY": return <InventoryWorkspace color={workspace?.color} />;
    default: return <div style={{ padding: 16 }}>Unknown tab type</div>;
  }
}


// ============================================================
// STATE MANAGEMENT
// ============================================================
const initialState = {
  workspaces: {},
  tiles: {},
  pages: {},
  pageOrder: [],
  activePageId: null,
  grid: { cols: GRID_COLS, rows: GRID_ROWS },
  colorIndex: 0,
  activeTileId: null,
};

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function findOpenPosition(tiles, size) {
  const occupied = new Set();
  tiles.forEach(t => {
    for (let r = t.row; r < t.row + t.rows; r++) {
      for (let c = t.col; c < t.col + t.cols; c++) {
        occupied.add(`${r}-${c}`);
      }
    }
  });
  for (let r = 0; r <= GRID_ROWS - size.rows; r++) {
    for (let c = 0; c <= GRID_COLS - size.cols; c++) {
      let fits = true;
      for (let dr = 0; dr < size.rows && fits; dr++) {
        for (let dc = 0; dc < size.cols && fits; dc++) {
          if (occupied.has(`${r + dr}-${c + dc}`)) fits = false;
        }
      }
      if (fits) return { row: r, col: c };
    }
  }
  return { row: 0, col: 0 };
}

function reducer(state, action) {
  switch (action.type) {
    case "CREATE_WORKSPACE": {
      const { patientId } = action;
      const existing = Object.values(state.workspaces).find(w => w.patientId === patientId);
      if (existing) {
        const existingTile = Object.values(state.tiles).find(t => t.workspaceId === existing.id);
        if (existingTile) return { ...state, activePageId: existingTile.pageId };
        return state;
      }
      const wsId = generateId();
      const pageId = generateId();
      const color = WORKSPACE_COLORS[state.colorIndex % WORKSPACE_COLORS.length];
      const tileId = generateId();
      const tabId = generateId();
      const size = SNAP_SIZES.HALF_H;
      return {
        ...state,
        colorIndex: state.colorIndex + 1,
        activePageId: pageId,
        pages: { ...state.pages, [pageId]: { id: pageId, workspaceId: wsId, label: null } },
        pageOrder: [...state.pageOrder, pageId],
        workspaces: {
          ...state.workspaces,
          [wsId]: {
            id: wsId, patientId, color,
            rxPrescription: null, // { status, techEntry, eOrder, rxNumber, rphReview }
            tabs: [
              { id: tabId, type: "RX_ENTRY", label: "New Rx" },
              { id: generateId(), type: "RPH_VERIFY", label: "RPh Verify" },
              { id: generateId(), type: "FILL", label: "Fill" },
              { id: generateId(), type: "FILL_VERIFY", label: "Fill Verify" },
              { id: generateId(), type: "PATIENT_PROFILE", label: "Profile" },
              { id: generateId(), type: "MED_HISTORY", label: "Med History" },
              { id: generateId(), type: "INSURANCE", label: "Insurance" },
              { id: generateId(), type: "ALLERGIES", label: "Allergies" },
              { id: generateId(), type: "NOTES", label: "Notes" },
            ],
          },
        },
        tiles: {
          ...state.tiles,
          [tileId]: {
            id: tileId, workspaceId: wsId, pageId,
            tabIds: [tabId], activeTabId: tabId,
            col: 0, row: 0, cols: size.cols, rows: size.rows,
          },
        },
        activeTileId: tileId,
      };
    }
    case "CREATE_TASK_WORKSPACE": {
      const { taskType } = action; // "data_entry" | "fill" | "verify" | "inventory"
      // Check if one already exists
      const existingTask = Object.values(state.workspaces).find(w => w.taskType === taskType);
      if (existingTask) {
        const existingPage = Object.values(state.pages).find(p => p.workspaceId === existingTask.id);
        if (existingPage) return { ...state, activePageId: existingPage.id };
        return state;
      }
      const wsId = generateId();
      const pageId = generateId();
      const color = taskType === "data_entry"
        ? { bg: "#5b8af5", text: "#a0bff0", border: "#223050", light: "#141a24" }
        : taskType === "verify"
          ? { bg: "#4abe6a", text: "#90e0a0", border: "#223d28", light: "#141f18" }
          : taskType === "inventory"
            ? { bg: "#40c0b0", text: "#90e0d0", border: "#223d38", light: "#141f1e" }
            : { bg: "#e8a030", text: "#f0d090", border: "#3d3020", light: "#1f1a14" };
      const tileId = generateId();
      const tabId = generateId();
      const tabType = taskType === "inventory" ? "INVENTORY" : "DATA_ENTRY_WS";
      const tabLabel = taskType === "data_entry" ? "Data Entry"
        : taskType === "inventory" ? "Inventory"
          : taskType === "verify" ? "RPh Verify" : "Fill Station";
      return {
        ...state,
        colorIndex: state.colorIndex + 1,
        activePageId: pageId,
        pages: { ...state.pages, [pageId]: { id: pageId, workspaceId: wsId, label: tabLabel } },
        pageOrder: [...state.pageOrder, pageId],
        workspaces: {
          ...state.workspaces,
          [wsId]: {
            id: wsId, patientId: null, taskType, color,
            rxPrescription: null,
            activeQueueItem: null,
            tabs: [
              { id: tabId, type: tabType, label: tabLabel },
            ],
          },
        },
        tiles: {
          ...state.tiles,
          [tileId]: {
            id: tileId, workspaceId: wsId, pageId,
            tabIds: [tabId], activeTabId: tabId,
            col: 0, row: 0, cols: GRID_COLS, rows: GRID_ROWS,
          },
        },
        activeTileId: tileId,
      };
    }

    case "SET_QUEUE_ITEM": {
      const { workspaceId, patientId } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...ws, activeQueueItem: { patientId } },
        },
      };
    }

    case "OPEN_TAB_IN_TILE": {
      const { tileId, tabId } = action;
      const tile = state.tiles[tileId];
      if (!tile) return state;
      const newTabIds = tile.tabIds.includes(tabId) ? tile.tabIds : [...tile.tabIds, tabId];
      return { ...state, tiles: { ...state.tiles, [tileId]: { ...tile, tabIds: newTabIds, activeTabId: tabId } } };
    }
    case "SET_ACTIVE_TAB": {
      const { tileId, tabId } = action;
      const tile = state.tiles[tileId];
      if (!tile) return state;
      return { ...state, tiles: { ...state.tiles, [tileId]: { ...tile, activeTabId: tabId } }, activeTileId: tileId };
    }
    case "DETACH_TAB": {
      const { tileId, tabId, col: dropCol, row: dropRow } = action;
      const tile = state.tiles[tileId];
      if (!tile || tile.tabIds.length <= 1) return state;
      const newTileId = generateId();
      const remainingTabs = tile.tabIds.filter(id => id !== tabId);
      const size = SNAP_SIZES.QUARTER;
      const pageTiles = Object.values(state.tiles).filter(t => t.pageId === tile.pageId);
      const pos = (dropCol !== undefined && dropRow !== undefined)
        ? { row: Math.max(0, Math.min(dropRow, GRID_ROWS - size.rows)), col: Math.max(0, Math.min(dropCol, GRID_COLS - size.cols)) }
        : findOpenPosition(pageTiles, size);
      return {
        ...state,
        tiles: {
          ...state.tiles,
          [tileId]: { ...tile, tabIds: remainingTabs, activeTabId: remainingTabs[0] },
          [newTileId]: { id: newTileId, workspaceId: tile.workspaceId, pageId: tile.pageId, tabIds: [tabId], activeTabId: tabId, col: pos.col, row: pos.row, cols: size.cols, rows: size.rows },
        },
        activeTileId: newTileId,
      };
    }
    case "REATTACH_TAB": {
      const { fromTileId, toTileId, tabId } = action;
      const fromTile = state.tiles[fromTileId];
      const toTile = state.tiles[toTileId];
      if (!fromTile || !toTile) return state;
      if (fromTile.workspaceId !== toTile.workspaceId) return state;
      const newTiles = { ...state.tiles };
      newTiles[toTileId] = { ...toTile, tabIds: [...toTile.tabIds, tabId], activeTabId: tabId };
      if (fromTile.tabIds.length <= 1) {
        delete newTiles[fromTileId];
      } else {
        const remaining = fromTile.tabIds.filter(id => id !== tabId);
        newTiles[fromTileId] = { ...fromTile, tabIds: remaining, activeTabId: remaining[0] };
      }
      return { ...state, tiles: newTiles, activeTileId: toTileId };
    }
    case "CLOSE_TAB": {
      const { tileId, tabId } = action;
      const tile = state.tiles[tileId];
      if (!tile) return state;
      const remaining = tile.tabIds.filter(id => id !== tabId);
      if (remaining.length === 0) {
        const newTiles = { ...state.tiles };
        delete newTiles[tileId];
        return { ...state, tiles: newTiles, activeTileId: state.activeTileId === tileId ? null : state.activeTileId };
      }
      return { ...state, tiles: { ...state.tiles, [tileId]: { ...tile, tabIds: remaining, activeTabId: remaining[0] } } };
    }
    case "RESIZE_TILE": {
      const { tileId, size } = action;
      const tile = state.tiles[tileId];
      if (!tile) return state;
      return { ...state, tiles: { ...state.tiles, [tileId]: { ...tile, cols: size.cols, rows: size.rows } } };
    }
    case "MOVE_TILE": {
      const { tileId, col, row } = action;
      const tile = state.tiles[tileId];
      if (!tile) return state;
      return { ...state, tiles: { ...state.tiles, [tileId]: { ...tile, col: Math.max(0, Math.min(col, GRID_COLS - tile.cols)), row: Math.max(0, Math.min(row, GRID_ROWS - tile.rows)) } } };
    }
    case "SET_ACTIVE_TILE": return { ...state, activeTileId: action.tileId };
    case "CLOSE_WORKSPACE": {
      const { workspaceId } = action;
      const newWorkspaces = { ...state.workspaces };
      delete newWorkspaces[workspaceId];
      const newTiles = {};
      Object.entries(state.tiles).forEach(([id, tile]) => { if (tile.workspaceId !== workspaceId) newTiles[id] = tile; });
      const newPages = { ...state.pages };
      const removedPageIds = new Set();
      Object.entries(newPages).forEach(([id, page]) => { if (page.workspaceId === workspaceId) { removedPageIds.add(id); delete newPages[id]; } });
      const newPageOrder = state.pageOrder.filter(id => !removedPageIds.has(id));
      let newActivePageId = state.activePageId;
      if (removedPageIds.has(state.activePageId)) newActivePageId = newPageOrder.length > 0 ? newPageOrder[newPageOrder.length - 1] : null;
      return { ...state, workspaces: newWorkspaces, tiles: newTiles, pages: newPages, pageOrder: newPageOrder, activePageId: newActivePageId };
    }
    case "SET_ACTIVE_PAGE": return { ...state, activePageId: action.pageId };
    case "NAVIGATE_PAGE": {
      const idx = state.pageOrder.indexOf(state.activePageId);
      if (idx === -1) return state;
      const newIdx = action.direction === "next" ? (idx + 1) % state.pageOrder.length : (idx - 1 + state.pageOrder.length) % state.pageOrder.length;
      return { ...state, activePageId: state.pageOrder[newIdx] };
    }

    case "SUBMIT_RX": {
      const { workspaceId, techEntry, eOrder, rxNumber } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              status: "in_review",
              techEntry,   // frozen snapshot of what the tech entered
              eOrder,      // the e-order data (original + transcribed)
              rxNumber,
              rphReview: null,
              submittedAt: new Date().toISOString(),
            },
          },
        },
      };
    }

    case "RPH_DECISION": {
      const { workspaceId, decision, notes, checkedFields } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || !ws.rxPrescription) return state;
      const newStatus = decision === "approve" ? "approved"
        : decision === "return" ? "returned"
          : decision === "call_prescriber" ? "call_prescriber"
            : ws.rxPrescription.status;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: newStatus,
              rphReview: {
                decision,
                notes: notes || "",
                checkedFields: checkedFields || [],
                decidedAt: new Date().toISOString(),
              },
            },
          },
        },
      };
    }

    case "RESET_RX": {
      const { workspaceId } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...ws, rxPrescription: null },
        },
      };
    }

    case "START_FILL": {
      const { workspaceId } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || ws.rxPrescription?.status !== "approved") return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: "filling",
              fillData: null,
            },
          },
        },
      };
    }

    case "SUBMIT_FILL": {
      const { workspaceId, fillData } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || ws.rxPrescription?.status !== "filling") return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: "fill_review",
              fillData: {
                ...fillData,
                submittedAt: new Date().toISOString(),
              },
              rphFillReview: null,
            },
          },
        },
      };
    }

    case "RPH_FILL_DECISION": {
      const { workspaceId, decision, notes } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || ws.rxPrescription?.status !== "fill_review") return state;
      const newStatus = decision === "approve" ? "filled"
        : decision === "refill" ? "filling"
          : ws.rxPrescription.status;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: newStatus,
              fillData: decision === "refill" ? null : ws.rxPrescription.fillData,
              rphFillReview: {
                decision,
                notes: notes || "",
                decidedAt: new Date().toISOString(),
              },
            },
          },
        },
      };
    }

    default: return state;
  }
}


// ============================================================
// CONTEXT
// ============================================================
const PharmIDEContext = createContext(null);

// Shared tab drag state (mouse-event based, bypasses HTML5 DnD issues in WebView2)
const tabDragState = { active: false, tabId: null, fromTileId: null, workspaceId: null, tabCount: 0, ghostEl: null };


// ============================================================
// QUEUE BAR — Rx pipeline at the bottom of the screen
// ============================================================
const QUEUE_LANES = [
  { status: null, label: "Incoming", icon: "→", color: T.textMuted, tabType: "RX_ENTRY" },
  { status: "in_review", label: "RPh Review", icon: "Rv", color: "#e8a030", tabType: "RPH_VERIFY" },
  { status: "approved", label: "Ready to Fill", icon: "✓", color: "#4abe6a", tabType: "FILL" },
  { status: "filling", label: "Filling", icon: "Fl", color: "#5b8af5", tabType: "FILL" },
  { status: "fill_review", label: "Fill Check", icon: "Fv", color: "#8b5cf6", tabType: "FILL_VERIFY" },
  { status: "filled", label: "Pickup", icon: "✓", color: "#4abe6a", tabType: null },
];

function QueueBar({ state, currentRole, onRxClick }) {
  const [collapsed, setCollapsed] = useState(true);

  // Collect all Rxs across workspaces
  const allRxs = useMemo(() => {
    const rxs = [];
    Object.values(state.workspaces).forEach(ws => {
      const patient = MOCK_PATIENTS.find(p => p.id === ws.patientId);
      if (!patient) return;

      const rx = ws.rxPrescription;
      // If no rx, this workspace has an incoming e-order (or is empty)
      // Check if patient has an e-order pending
      if (!rx) {
        // Show as "incoming" if patient has pending work
        rxs.push({
          workspaceId: ws.id,
          status: null,
          patient,
          color: ws.color,
          drugName: "New Rx",
          strength: "",
          rxNumber: null,
          age: null,
          isControl: false,
        });
      } else {
        const te = rx.techEntry || {};
        const age = rx.submittedAt ? Math.floor((Date.now() - new Date(rx.submittedAt).getTime()) / 60000) : null;
        rxs.push({
          workspaceId: ws.id,
          status: rx.status,
          patient,
          color: ws.color,
          drugName: te.drugName || "—",
          strength: te.strength || "",
          rxNumber: rx.rxNumber,
          age,
          isControl: te.schedule?.startsWith("C-"),
          schedule: te.schedule,
        });
      }
    });
    return rxs;
  }, [state.workspaces]);

  // Group by lane
  const lanes = useMemo(() => {
    return QUEUE_LANES.map(lane => ({
      ...lane,
      rxs: allRxs.filter(rx => {
        if (lane.status === null) return rx.status === null || rx.status === "returned" || rx.status === "call_prescriber";
        return rx.status === lane.status;
      }),
    }));
  }, [allRxs]);

  // Summary counts for collapsed view
  const totalActive = allRxs.filter(rx => rx.status && rx.status !== "filled").length;
  const needsAttention = useMemo(() => {
    if (currentRole === "tech" || currentRole === "super") {
      return allRxs.filter(rx => rx.status === null || rx.status === "approved" || rx.status === "filling" || rx.status === "returned").length;
    }
    if (currentRole === "rph") {
      return allRxs.filter(rx => rx.status === "in_review" || rx.status === "fill_review").length;
    }
    return 0;
  }, [allRxs, currentRole]);

  if (allRxs.length === 0) return null;

  return (
    <div style={{
      background: T.queueBg, borderTop: `1px solid ${T.surfaceBorder}`,
      flexShrink: 0, fontFamily: T.mono,
      transition: "height 0.2s ease",
    }}>
      {/* Queue header — always visible */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          height: 30, display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 14px", cursor: "pointer", userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: T.textSecondary, textTransform: "uppercase", letterSpacing: 1 }}>
            Queue
          </span>
          {lanes.map(lane => (
            lane.rxs.length > 0 && (
              <span key={lane.label} style={{
                fontSize: 9, padding: "2px 7px", borderRadius: T.radiusSm,
                background: lane.color + "18", color: lane.color + "cc",
                fontWeight: 600,
              }}>
                {lane.rxs.length} {lane.label}
              </span>
            )
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {needsAttention > 0 && (
            <span style={{ fontSize: 10, color: "#e8a030", fontWeight: 600 }}>
              {needsAttention} need{needsAttention === 1 ? "s" : ""} attention
            </span>
          )}
          <span style={{ fontSize: 12, color: T.textMuted, transition: "transform 0.2s", transform: collapsed ? "rotate(0)" : "rotate(180deg)" }}>▲</span>
        </div>
      </div>

      {/* Queue lanes — collapsible */}
      {!collapsed && (
        <div style={{
          display: "flex", gap: 3, padding: "0 10px 10px", height: 110,
          overflowX: "auto", overflowY: "hidden",
        }}>
          {lanes.map(lane => (
            <div key={lane.label} style={{
              flex: lane.rxs.length > 0 ? `${Math.max(lane.rxs.length, 1)}` : "0 0 auto",
              minWidth: lane.rxs.length > 0 ? 120 : 60,
              display: "flex", flexDirection: "column",
            }}>
              {/* Lane header */}
              <div style={{
                fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8,
                color: lane.color + "aa", padding: "2px 8px", marginBottom: 4,
                display: "flex", alignItems: "center", gap: 4,
              }}>
                <span>{lane.icon}</span>
                <span>{lane.label}</span>
                {lane.rxs.length > 0 && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, color: lane.color + "88",
                    background: lane.color + "10", borderRadius: T.radiusSm,
                    padding: "0 5px", marginLeft: 2,
                  }}>
                    {lane.rxs.length}
                  </span>
                )}
              </div>

              {/* Rx cards */}
              <div style={{
                flex: 1, display: "flex", gap: 4, overflowX: "auto",
                padding: "0 4px",
              }}>
                {lane.rxs.map((rx, i) => (
                  <div
                    key={rx.workspaceId + "-" + i}
                    onClick={() => lane.tabType && onRxClick(rx.workspaceId, lane.tabType)}
                    style={{
                      minWidth: 110, maxWidth: 150, padding: "7px 9px",
                      borderRadius: T.radiusSm, cursor: lane.tabType ? "pointer" : "default",
                      background: `${rx.color.bg}10`,
                      border: `1px solid ${rx.color.bg}20`,
                      display: "flex", flexDirection: "column", justifyContent: "space-between",
                      transition: "all 0.15s",
                      flexShrink: 0,
                    }}
                    onMouseOver={(e) => { if (lane.tabType) e.currentTarget.style.background = rx.color.bg + "20"; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = rx.color.bg + "10"; }}
                  >
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: T.textPrimary, lineHeight: 1.3 }}>
                        {rx.drugName} {rx.strength}
                      </div>
                      <div style={{ fontSize: 9, color: T.textMuted, marginTop: 2 }}>
                        {rx.patient.name.split(" ").pop()}
                        {rx.rxNumber && <span style={{ marginLeft: 4, color: T.textMuted }}>· {rx.rxNumber.split("-").pop()}</span>}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
                      {rx.isControl && (
                        <span style={{
                          fontSize: 8, fontWeight: 800, color: "#e8a030",
                          background: "#f59e0b15", padding: "0 4px", borderRadius: 2,
                        }}>
                          {rx.schedule}
                        </span>
                      )}
                      {rx.age != null && (
                        <span style={{
                          fontSize: 8, color: rx.age > 15 ? "#f59e0b" : rx.age > 30 ? "#ef4444" : "#475569",
                          fontWeight: rx.age > 15 ? 700 : 400,
                        }}>
                          {rx.age}m
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {lane.rxs.length === 0 && (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#2a2d3a", fontSize: 10 }}>
                    —
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ============================================================
// TILE COMPONENT
// ============================================================
function Tile({ tile, workspace, patient }) {
  const { dispatch, state } = useContext(PharmIDEContext);
  const [isDragging, setIsDragging] = useState(false);
  const [showTabSearch, setShowTabSearch] = useState(false);
  const [dropHighlight, setDropHighlight] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeCols, setResizeCols] = useState(null);
  const [resizeRows, setResizeRows] = useState(null);
  const tileRef = useRef(null);
  const gridRef = useRef(null);

  const color = workspace.color;
  const allTabs = workspace.tabs;
  const openTabs = allTabs.filter(t => tile.tabIds.includes(t.id));
  const activeTab = allTabs.find(t => t.id === tile.activeTabId);
  const availableTabs = allTabs.filter(t => !tile.tabIds.includes(t.id));

  const handleTabMouseDown = (e, tabId) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;

    const onMove = (me) => {
      if (!dragging && (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5)) {
        dragging = true;
        tabDragState.active = true;
        tabDragState.tabId = tabId;
        tabDragState.fromTileId = tile.id;
        tabDragState.workspaceId = workspace.id;
        tabDragState.tabCount = tile.tabIds.length;
        // Create ghost
        const ghost = document.createElement("div");
        ghost.textContent = allTabs.find(t => t.id === tabId)?.label || "Tab";
        Object.assign(ghost.style, {
          position: "fixed", zIndex: 9999, padding: "6px 14px", borderRadius: "8px",
          background: color.bg, color: "#fff", fontSize: "12px", fontWeight: "600",
          fontFamily: T.sans, pointerEvents: "none", opacity: "0.9",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          transform: "translate(-50%, -50%)",
        });
        document.body.appendChild(ghost);
        tabDragState.ghostEl = ghost;
      }
      if (dragging && tabDragState.ghostEl) {
        tabDragState.ghostEl.style.left = me.clientX + "px";
        tabDragState.ghostEl.style.top = me.clientY + "px";
      }
    };

    const onUp = (me) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (tabDragState.ghostEl) {
        tabDragState.ghostEl.remove();
        tabDragState.ghostEl = null;
      }
      if (!dragging) {
        // Was just a click, activate the tab
        dispatch({ type: "SET_ACTIVE_TAB", tileId: tile.id, tabId });
        tabDragState.active = false;
        return;
      }
      // Find what we dropped on
      const gridEl = tileRef.current?.closest("[data-grid]");
      if (!gridEl) { tabDragState.active = false; return; }
      const gridRect = gridEl.getBoundingClientRect();
      const cellW = gridRect.width / GRID_COLS, cellH = gridRect.height / GRID_ROWS;
      const col = Math.max(0, Math.min(GRID_COLS - 6, Math.round((me.clientX - gridRect.left) / cellW - 3)));
      const row = Math.max(0, Math.min(GRID_ROWS - 4, Math.round((me.clientY - gridRect.top) / cellH - 2)));

      // Check if dropped on another tile of the same workspace
      const dropTarget = document.elementFromPoint(me.clientX, me.clientY);
      const targetTileEl = dropTarget?.closest?.("[data-tile-id]");
      const targetTileId = targetTileEl?.dataset?.tileId;

      if (targetTileId && targetTileId !== tile.id) {
        // Check if same workspace
        const targetTile = state.tiles[targetTileId];
        if (targetTile && targetTile.workspaceId === workspace.id) {
          dispatch({ type: "REATTACH_TAB", fromTileId: tile.id, toTileId: targetTileId, tabId });
          tabDragState.active = false;
          return;
        }
      }

      // Drop on grid — detach or move
      if (tabDragState.tabCount <= 1) {
        dispatch({ type: "MOVE_TILE", tileId: tile.id, col, row });
      } else {
        dispatch({ type: "DETACH_TAB", tileId: tile.id, tabId, col, row });
      }
      tabDragState.active = false;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleTileMouseDown = (e) => {
    if (e.target.closest("[data-tab-bar]") || e.target.closest("[data-resize]") || e.target.closest("button")) return;
    e.preventDefault();
    dispatch({ type: "SET_ACTIVE_TILE", tileId: tile.id });
    setIsDragging(true);
    gridRef.current = tileRef.current.closest("[data-grid]");
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e) => {
      const grid = gridRef.current; if (!grid) return;
      const gridRect = grid.getBoundingClientRect();
      const col = Math.round((e.clientX - gridRect.left) / (gridRect.width / GRID_COLS) - tile.cols / 2);
      const row = Math.round((e.clientY - gridRect.top) / (gridRect.height / GRID_ROWS) - tile.rows / 2);
      dispatch({ type: "MOVE_TILE", tileId: tile.id, col, row });
    };
    const handleMouseUp = () => setIsDragging(false);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => { window.removeEventListener("mousemove", handleMouseMove); window.removeEventListener("mouseup", handleMouseUp); };
  }, [isDragging, tile.id, tile.cols, tile.rows, dispatch]);

  const handleResizeMouseDown = (e) => {
    e.preventDefault(); e.stopPropagation();
    setIsResizing(true); setResizeCols(tile.cols); setResizeRows(tile.rows);
    gridRef.current = tileRef.current.closest("[data-grid]");
  };

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e) => {
      const grid = gridRef.current; if (!grid) return;
      const gridRect = grid.getBoundingClientRect();
      const cellW = gridRect.width / GRID_COLS;
      const cellH = gridRect.height / GRID_ROWS;
      setResizeCols(Math.min(Math.max(2, Math.round((e.clientX - gridRect.left) / cellW - tile.col)), GRID_COLS - tile.col));
      setResizeRows(Math.min(Math.max(2, Math.round((e.clientY - gridRect.top) / cellH - tile.row)), GRID_ROWS - tile.row));
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      const liveCols = resizeCols || tile.cols;
      const liveRows = resizeRows || tile.rows;
      let bestSize = null, bestDist = Infinity;
      Object.values(SNAP_SIZES).forEach(size => {
        if (tile.col + size.cols > GRID_COLS || tile.row + size.rows > GRID_ROWS) return;
        const dist = Math.abs(size.cols - liveCols) + Math.abs(size.rows - liveRows);
        if (dist < bestDist) { bestDist = dist; bestSize = size; }
      });
      if (bestSize) dispatch({ type: "RESIZE_TILE", tileId: tile.id, size: bestSize });
      setResizeCols(null); setResizeRows(null);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => { window.removeEventListener("mousemove", handleMouseMove); window.removeEventListener("mouseup", handleMouseUp); };
  }, [isResizing, tile.id, tile.col, tile.row, tile.cols, tile.rows, resizeCols, resizeRows, dispatch]);

  return (
    <div
      ref={tileRef}
      data-tile-id={tile.id}
      onClick={() => dispatch({ type: "SET_ACTIVE_TILE", tileId: tile.id })}
      onDrop={null}
      onDragOver={null}
      onDragLeave={null}
      style={{
        gridColumn: `${tile.col + 1} / span ${isResizing && resizeCols ? resizeCols : tile.cols}`,
        gridRow: `${tile.row + 1} / span ${isResizing && resizeRows ? resizeRows : tile.rows}`,
        display: "flex", flexDirection: "column", borderRadius: T.radius,
        border: dropHighlight ? `3px dashed ${color.bg}` : `1px solid ${color.bg}30`,
        background: T.tileBg,
        overflow: "hidden",
        boxShadow: isDragging || isResizing
          ? `0 12px 40px ${color.bg}30, 0 0 0 2px ${color.bg}50`
          : `0 4px 24px #00000050, inset 0 1px 0 ${color.bg}12`,
        zIndex: isDragging || isResizing ? 100 : (tile.id === state.activeTileId ? 10 : 1),
        transition: isDragging || isResizing ? "none" : "box-shadow 0.2s ease",
        cursor: isDragging ? "grabbing" : "default", position: "relative",
      }}
    >
      {/* Title bar */}
      <div onMouseDown={handleTileMouseDown} style={{
        background: T.surface,
        borderBottom: `1px solid ${color.bg}25`,
        color: T.textPrimary, padding: "8px 14px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        cursor: "grab", userSelect: "none", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: color.bg, opacity: 0.8, boxShadow: `0 0 6px ${color.bg}60` }} />
          <span style={{ fontWeight: 600, fontSize: 13, fontFamily: T.sans, color: color.text }}>{patient ? patient.name : (workspace.taskType === "data_entry" ? "Data Entry" : workspace.taskType === "inventory" ? "Inventory" : workspace.taskType || "Task")}</span>
          <span style={{ fontSize: 11, color: `${color.bg}80` }}>{color.name || ""}</span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {Object.entries(SNAP_SIZES).map(([key, size]) => {
            const isActive = tile.cols === size.cols && tile.rows === size.rows;
            return (
              <button key={key}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: "RESIZE_TILE", tileId: tile.id, size }); }}
                style={{
                  background: isActive ? `${color.bg}30` : "#ffffff08",
                  border: "none", borderRadius: T.radiusXs, color: T.textSecondary, fontSize: 9,
                  padding: "3px 4px", cursor: "pointer", display: "flex", alignItems: "center",
                  lineHeight: 0,
                }}
                title={size.label}
              >{size.icon(isActive ? `${color.bg}80` : "#ffffff15")}</button>
            );
          })}
          <button onClick={(e) => { e.stopPropagation(); dispatch({ type: "CLOSE_WORKSPACE", workspaceId: workspace.id }); }}
            style={{ background: "#ffffff08", border: "none", borderRadius: T.radiusXs, color: T.textMuted, fontSize: 13, padding: "0 6px", cursor: "pointer", marginLeft: 4 }}>×</button>
        </div>
      </div>

      {/* Tab bar */}
      <div data-tab-bar="true" style={{
        display: "flex", alignItems: "center", background: T.tileBg,
        borderBottom: `1px solid ${color.bg}20`, overflowX: "auto", flexShrink: 0,
      }}>
        {openTabs.map(tab => {
          const tabType = TAB_TYPES[tab.type];
          const isActive = tab.id === tile.activeTabId;
          return (
            <div key={tab.id}
              onMouseDown={(e) => handleTabMouseDown(e, tab.id)}
              style={{
                padding: "9px 14px", fontSize: 12, fontFamily: T.sans,
                fontWeight: isActive ? 600 : 400, background: isActive ? T.surfaceRaised : "transparent",
                borderBottom: isActive ? `2px solid ${color.bg}` : "2px solid transparent",
                color: isActive ? T.textPrimary : T.textMuted, cursor: "grab",
                display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                userSelect: "none", transition: "all 0.15s ease",
              }}
            >
              <span style={{ fontSize: 9, fontWeight: 700, fontFamily: T.mono, opacity: 0.6, letterSpacing: 0.3 }}>{tabType?.icon}</span>
              {tabType?.label || tab.label}
              <span onClick={(e) => { e.stopPropagation(); dispatch({ type: "CLOSE_TAB", tileId: tile.id, tabId: tab.id }); }}
                style={{ fontSize: 11, opacity: 0.3, cursor: "pointer", padding: "0 2px" }}>×</span>
            </div>
          );
        })}
        {availableTabs.length > 0 && (
          <button onClick={(e) => { e.stopPropagation(); setShowTabSearch(prev => !prev); }}
            style={{
              background: showTabSearch ? T.surfaceRaised : "none",
              border: showTabSearch ? `1px solid ${T.surfaceBorder}` : "none",
              color: color.bg, fontSize: 18, cursor: "pointer", padding: "4px 12px",
              opacity: showTabSearch ? 1 : 0.5, fontWeight: 700, lineHeight: 1, borderRadius: T.radiusXs,
            }}>{showTabSearch ? "−" : "+"}</button>
        )}
      </div>

      {/* Content */}
      <div style={{
        flex: 1, overflow: "auto", background: T.surfaceRaised, color: T.textPrimary,
        position: "relative", minHeight: 0,
        scrollbarWidth: "thin", scrollbarColor: `${color.bg}30 transparent`,
      }}>
        {showTabSearch ? (
          <TabSearchPanel availableTabs={availableTabs} tileId={tile.id} color={color} onClose={() => setShowTabSearch(false)} />
        ) : (
          activeTab && <TabContent tab={activeTab} patient={patient} workspace={workspace} />
        )}
      </div>

      {/* Resize handles */}
      <div data-resize="true" onMouseDown={handleResizeMouseDown} style={{ position: "absolute", top: 0, right: -3, width: 6, height: "100%", cursor: "ew-resize", zIndex: 20 }} />
      <div data-resize="true" onMouseDown={handleResizeMouseDown} style={{ position: "absolute", bottom: -3, left: 0, height: 6, width: "100%", cursor: "ns-resize", zIndex: 20 }} />
      <div data-resize="true" onMouseDown={handleResizeMouseDown} style={{
        position: "absolute", bottom: -4, right: -4, width: 14, height: 14,
        cursor: "nwse-resize", zIndex: 30, borderRadius: 3, background: isResizing ? color.bg : "transparent",
      }}>
        {!isResizing && <div style={{ position: "absolute", bottom: 3, right: 3, width: 8, height: 8, opacity: 0.3, borderRight: `2px solid ${color.bg}`, borderBottom: `2px solid ${color.bg}` }} />}
      </div>
    </div>
  );
}


// ============================================================
// TAB SEARCH PANEL
// ============================================================
function TabSearchPanel({ availableTabs, tileId, color, onClose }) {
  const { dispatch } = useContext(PharmIDEContext);
  const [query, setQuery] = useState("");
  const [hlIndex, setHlIndex] = useState(0);
  const inputRef = useRef(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return availableTabs;
    const q = query.toLowerCase();
    return availableTabs.filter(tab => (TAB_TYPES[tab.type]?.label || tab.label || "").toLowerCase().includes(q))
      .sort((a, b) => {
        const aL = (TAB_TYPES[a.type]?.label || "").toLowerCase();
        const bL = (TAB_TYPES[b.type]?.label || "").toLowerCase();
        const q2 = query.toLowerCase();
        if (aL.startsWith(q2) && !bL.startsWith(q2)) return -1;
        if (!aL.startsWith(q2) && bL.startsWith(q2)) return 1;
        return 0;
      });
  }, [query, availableTabs]);

  useEffect(() => { setHlIndex(0); }, [query]);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  const handleSelect = (tab) => { dispatch({ type: "OPEN_TAB_IN_TILE", tileId, tabId: tab.id }); onClose(); };

  return (
    <div style={{ padding: 16 }}>
      <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHlIndex(i => Math.min(i + 1, filtered.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHlIndex(i => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && filtered[hlIndex]) handleSelect(filtered[hlIndex]);
          else if (e.key === "Escape") onClose();
        }}
        placeholder="Search for a tab to open..."
        style={{
          width: "100%", padding: "10px 14px", borderRadius: 8,
          border: `2px solid ${color.border}80`, background: color.light,
          color: color.text, fontSize: 14, fontFamily: T.sans,
          outline: "none", boxSizing: "border-box",
        }}
      />
      <div style={{ marginTop: 8 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 14, color: T.textSecondary, fontSize: 13, textAlign: "center" }}>No matching tabs</div>
        ) : filtered.map((tab, i) => {
          const tabType = TAB_TYPES[tab.type];
          return (
            <div key={tab.id} onClick={(e) => { e.stopPropagation(); handleSelect(tab); }}
              onMouseEnter={() => setHlIndex(i)}
              style={{
                padding: "10px 14px", cursor: "pointer",
                background: i === hlIndex ? color.light : "transparent",
                border: i === hlIndex ? `1px solid ${color.border}40` : "1px solid transparent",
                borderRadius: 8, marginBottom: 2,
                display: "flex", alignItems: "center", gap: 10, transition: "all 0.1s ease",
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, fontFamily: T.mono, opacity: 0.5 }}>{tabType?.icon}</span>
              <div style={{ fontSize: 14, color: i === hlIndex ? color.text : T.textSecondary, fontWeight: i === hlIndex ? 600 : 400 }}>{tabType?.label}</div>
              {i === hlIndex && <span style={{ marginLeft: "auto", fontSize: 10, color: color.bg, fontFamily: T.mono, opacity: 0.7 }}>Enter ↵</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ============================================================
// PATIENT SEARCH DROPDOWN
// ============================================================
function PatientSearch({ patients, openPatientIds, onSelect }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hlIndex, setHlIndex] = useState(0);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return patients;
    const q = query.toLowerCase();
    return [...patients].sort((a, b) => {
      const aName = a.name.toLowerCase(), bName = b.name.toLowerCase();
      const aStarts = aName.startsWith(q) || aName.split(" ").some(w => w.startsWith(q));
      const bStarts = bName.startsWith(q) || bName.split(" ").some(w => w.startsWith(q));
      if (aStarts && !bStarts) return -1; if (!aStarts && bStarts) return 1;
      return 0;
    }).filter(p => `${p.name} ${p.dob} ${p.phone} ${p.address}`.toLowerCase().includes(q));
  }, [query, patients]);

  useEffect(() => { setHlIndex(0); }, [query]);
  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) { setOpen(false); setQuery(""); } };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = (patient) => {
    if (!openPatientIds.includes(patient.id)) onSelect(patient.id);
    setOpen(false); setQuery("");
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{
        background: "#5b8af510", border: `1px solid ${T.surfaceBorder}`,
        borderRadius: T.radiusSm, padding: "5px 14px", cursor: "pointer",
        color: "#5b8af5", fontSize: 12, fontFamily: T.sans,
        fontWeight: 500, display: "flex", alignItems: "center", gap: 6,
      }}><span style={{ fontSize: 14 }}>+</span> Open Patient</button>
    );
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHlIndex(i => Math.min(i + 1, filtered.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHlIndex(i => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && filtered[hlIndex]) handleSelect(filtered[hlIndex]);
          else if (e.key === "Escape") { setOpen(false); setQuery(""); }
        }}
        placeholder="Search patient name, DOB, phone..."
        style={{
          width: 280, padding: "6px 12px", borderRadius: T.radiusSm,
          border: `1px solid ${T.inputBorder}`, background: T.inputBg,
          color: T.textPrimary, fontSize: 12, fontFamily: T.sans, outline: "none",
        }}
      />
      <div style={{
        position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
        background: T.surfaceRaised, border: `1px solid ${T.surfaceBorder}`, borderRadius: T.radiusSm,
        overflow: "hidden", zIndex: 500, boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        maxHeight: 240, overflowY: "auto",
      }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "12px 16px", color: T.textSecondary, fontSize: 12, textAlign: "center" }}>No patients found</div>
        ) : filtered.map((patient, i) => {
          const isOpen = openPatientIds.includes(patient.id);
          return (
            <div key={patient.id} onClick={() => handleSelect(patient)} onMouseEnter={() => setHlIndex(i)}
              style={{
                padding: "8px 14px", cursor: isOpen ? "default" : "pointer",
                background: i === hlIndex ? T.surfaceHover : "transparent",
                borderBottom: `1px solid ${T.surfaceBorder}20`, opacity: isOpen ? 0.4 : 1,
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary }}>
                  {patient.name}{isOpen && <span style={{ marginLeft: 8, fontSize: 10, color: T.textMuted }}>● open</span>}
                </div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2, fontFamily: T.mono }}>
                  DOB: {patient.dob} · {patient.phone}
                </div>
              </div>
              {!isOpen && i === hlIndex && <span style={{ fontSize: 10, color: "#60a5fa", fontFamily: T.mono }}>Enter ↵</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ============================================================
// MAIN APP
// ============================================================
export default function PharmIDE() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const mockProvider = useMemo(() => createMockDataProvider(), []);
  const dataProvider = useMemo(() => {
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
      return createTauriDataProvider(mockProvider);
    }
    return mockProvider;
  }, [mockProvider]);
  const [currentRole, setCurrentRole] = useState("super"); // "tech" | "rph" | "super"
  const canDo = useCallback((action) => {
    const permissions = {
      tech: ["SUBMIT_RX", "RESET_RX", "START_FILL", "SUBMIT_FILL", "CREATE_WORKSPACE", "rx_entry", "fill"],
      rph: ["RPH_DECISION", "RPH_FILL_DECISION", "CREATE_WORKSPACE", "rph_verify", "fill_verify", "rx_entry_readonly"],
      super: ["SUBMIT_RX", "RESET_RX", "RPH_DECISION", "START_FILL", "SUBMIT_FILL", "RPH_FILL_DECISION", "CREATE_WORKSPACE", "rx_entry", "rph_verify", "fill", "fill_verify", "rx_entry_readonly"],
    };
    return (permissions[currentRole] || []).includes(action);
  }, [currentRole]);
  const contextValue = useMemo(() => ({ state, dispatch, currentRole, canDo }), [state, currentRole, canDo]);

  const activePage = state.activePageId ? state.pages[state.activePageId] : null;
  const activeWorkspace = activePage ? state.workspaces[activePage.workspaceId] : null;
  const tileEntries = Object.values(state.tiles).filter(t => t.pageId === state.activePageId);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (state.pageOrder.length <= 1) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "ArrowRight") { e.preventDefault(); dispatch({ type: "NAVIGATE_PAGE", direction: "next" }); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "ArrowLeft") { e.preventDefault(); dispatch({ type: "NAVIGATE_PAGE", direction: "prev" }); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.pageOrder.length]);

  const handleGridDrop = useCallback((e) => {
    e.preventDefault();
    const tabId = e.dataTransfer.getData("tabId");
    const fromTileId = e.dataTransfer.getData("fromTileId");
    const tabCount = parseInt(e.dataTransfer.getData("tabCount") || "0", 10);
    if (!tabId || !fromTileId) return;
    const gridEl = e.currentTarget, gridRect = gridEl.getBoundingClientRect();
    const cellW = gridRect.width / GRID_COLS, cellH = gridRect.height / GRID_ROWS;
    const col = Math.round((e.clientX - gridRect.left) / cellW - 3);
    const row = Math.round((e.clientY - gridRect.top) / cellH - 2);
    if (tabCount <= 1) { dispatch({ type: "MOVE_TILE", tileId: fromTileId, col, row }); return; }
    dispatch({ type: "DETACH_TAB", tileId: fromTileId, tabId, col, row });
  }, []);

  const handleGridDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; }, []);

  return (
    <PharmIDEContext.Provider value={contextValue}>
      <DataProviderContext.Provider value={dataProvider}>
        <div style={{
          width: "100vw", height: "100vh", maxHeight: "100vh",
          display: "flex", flexDirection: "column",
          background: "#0f1117", fontFamily: T.sans, overflow: "hidden",
          position: "fixed", top: 0, left: 0,
        }}>
          {/* Top Bar */}
          <div style={{
            height: 48, background: T.bg, borderBottom: `1px solid ${T.surfaceBorder}`,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0 16px", flexShrink: 0,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontWeight: 800, fontSize: 16, fontFamily: T.mono, letterSpacing: -0.5 }}>
                <span style={{ color: "#5b8af5" }}>Pharm</span><span style={{ color: T.textSecondary }}>IDE</span>
              </span>
              <span style={{ fontSize: 10, color: T.textMuted, fontFamily: T.mono }}>v0.3</span>
              {/* Role Switcher */}
              <div style={{ display: "flex", alignItems: "center", gap: 2, background: `${T.surface}`, borderRadius: T.radiusSm, padding: 2, border: `1px solid ${T.surfaceBorder}` }}>
                {[
                  { id: "tech", label: "TECH", icon: "" },
                  { id: "rph", label: "RPh", icon: "" },
                  { id: "super", label: "ALL", icon: "" },
                ].map(r => (
                  <button key={r.id} onClick={() => setCurrentRole(r.id)}
                    style={{
                      padding: "3px 10px", borderRadius: T.radiusXs, border: "none", cursor: "pointer",
                      fontSize: 10, fontWeight: 600, fontFamily: T.mono,
                      letterSpacing: 0.5,
                      background: currentRole === r.id
                        ? (r.id === "tech" ? "#5b8af530" : r.id === "rph" ? "#4abe6a30" : "#e8a03030")
                        : "transparent",
                      color: currentRole === r.id
                        ? (r.id === "tech" ? "#5b8af5" : r.id === "rph" ? "#4abe6a" : "#e8a030")
                        : T.textMuted,
                      transition: "all 0.15s ease",
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Page strip */}
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              {state.pageOrder.length > 1 && <button onClick={() => dispatch({ type: "NAVIGATE_PAGE", direction: "prev" })} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 14, padding: "4px 6px" }}>‹</button>}
              {state.pageOrder.map((pageId, idx) => {
                const page = state.pages[pageId];
                const ws = state.workspaces[page.workspaceId];
                const patient = ws ? MOCK_PATIENTS.find(p => p.id === ws.patientId) : null;
                const isActive = pageId === state.activePageId;
                const c = ws?.color;
                return (
                  <button key={pageId} onClick={() => dispatch({ type: "SET_ACTIVE_PAGE", pageId })}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "5px 14px", borderRadius: T.radiusSm, cursor: "pointer",
                      border: isActive ? `1px solid ${c?.bg || T.textMuted}40` : "1px solid transparent",
                      background: isActive ? `${c?.bg || T.textMuted}15` : "transparent",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: c?.bg || T.textMuted, opacity: isActive ? 0.9 : 0.4 }} />
                    <span style={{ fontSize: 12, fontWeight: isActive ? 600 : 400, color: isActive ? T.textPrimary : T.textMuted, fontFamily: T.sans }}>
                      {patient?.name.split(" ")[1] || page.label || "Page"}
                    </span>
                    <span style={{ fontSize: 9, color: T.textMuted, fontFamily: T.mono }}>{idx + 1}</span>
                  </button>
                );
              })}
              {state.pageOrder.length > 1 && <button onClick={() => dispatch({ type: "NAVIGATE_PAGE", direction: "next" })} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 14, padding: "4px 6px" }}>›</button>}
            </div>

            {/* Task Workspace Buttons */}
            <div style={{ display: "flex", gap: 4, marginRight: 8 }}>
              <button
                onClick={() => dispatch({ type: "CREATE_TASK_WORKSPACE", taskType: "data_entry" })}
                style={{
                  padding: "4px 10px", borderRadius: T.radiusSm, border: "1px solid #5b8af520",
                  background: "#5b8af510", color: "#5b8af5", cursor: "pointer",
                  fontSize: 10, fontWeight: 600, fontFamily: T.mono,
                  letterSpacing: 0.5,
                }}
              >
                Data Entry
              </button>
              <button
                onClick={() => dispatch({ type: "CREATE_TASK_WORKSPACE", taskType: "inventory" })}
                style={{
                  padding: "4px 10px", borderRadius: T.radiusSm, border: "1px solid #40c0b020",
                  background: "#40c0b010", color: "#40c0b0", cursor: "pointer",
                  fontSize: 10, fontWeight: 600, fontFamily: T.mono,
                  letterSpacing: 0.5,
                }}
              >
                Inventory
              </button>
            </div>
            <PatientSearch patients={MOCK_PATIENTS} openPatientIds={Object.values(state.workspaces).map(w => w.patientId)} onSelect={(patientId) => dispatch({ type: "CREATE_WORKSPACE", patientId })} />
          </div>

          {/* Grid Area */}
          <div data-grid="true" onDrop={handleGridDrop} onDragOver={handleGridDragOver}
            style={{
              flex: 1, minHeight: 0, display: "grid",
              gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
              gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
              gap: 6, padding: 8, position: "relative", background: T.bg,
            }}
          >
            {Array.from({ length: GRID_COLS * GRID_ROWS }).map((_, i) => (
              <div key={`cell-${i}`} style={{
                gridColumn: `${(i % GRID_COLS) + 1}`, gridRow: `${Math.floor(i / GRID_COLS) + 1}`,
                borderRadius: T.radiusXs, border: `1px solid ${T.surfaceBorder}20`,
                pointerEvents: "none",
              }} />
            ))}

            {tileEntries.map(tile => {
              const workspace = state.workspaces[tile.workspaceId];
              if (!workspace) return null;
              const patient = workspace.patientId ? MOCK_PATIENTS.find(p => p.id === workspace.patientId) : null;
              if (!patient && !workspace.taskType) return null;
              return <Tile key={tile.id} tile={tile} workspace={workspace} patient={patient} />;
            })}

            {!state.activePageId && (
              <div style={{
                gridColumn: "4 / span 6", gridRow: "3 / span 4",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: T.textMuted,
              }}>
                <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.2, fontFamily: T.mono }}>+</div>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, fontFamily: T.sans }}>No patient workspaces open</div>
                <div style={{ fontSize: 13, opacity: 0.5, textAlign: "center", lineHeight: 1.6, fontFamily: T.sans }}>
                  Open a patient from the top bar to begin.<br />Each patient gets their own grid page.
                </div>
              </div>
            )}
          </div>

          {/* ── Queue Bar ── */}
          <QueueBar
            state={state}
            currentRole={currentRole}
            onRxClick={(workspaceId, tabType) => {
              const ws = state.workspaces[workspaceId];
              if (!ws) return;
              // Find or navigate to the page for this workspace
              const page = Object.values(state.pages).find(p => p.workspaceId === workspaceId);
              if (page) {
                dispatch({ type: "SET_ACTIVE_PAGE", pageId: page.id });
                // Find the tile and switch to the right tab
                const tile = Object.values(state.tiles).find(t => t.workspaceId === workspaceId);
                if (tile) {
                  const tab = ws.tabs.find(t => t.type === tabType);
                  if (tab) dispatch({ type: "OPEN_TAB_IN_TILE", tileId: tile.id, tabId: tab.id });
                }
              }
            }}
          />

          {/* Status Bar */}
          <div style={{
            height: 28, background: T.bg, borderTop: `1px solid ${T.surfaceBorder}`,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0 12px", flexShrink: 0,
            fontFamily: T.mono, fontSize: 10, color: T.textMuted,
          }}>
            <div style={{ display: "flex", gap: 16 }}>
              <span>Pages: {state.pageOrder.length}</span>
              <span>Tiles: {tileEntries.length}</span>
              {activeWorkspace && (
                <span style={{ color: activeWorkspace.color.bg }}>
                  ● {MOCK_PATIENTS.find(p => p.id === activeWorkspace.patientId)?.name}
                </span>
              )}
            </div>
            <div>{state.pageOrder.length > 1 ? "Ctrl+← → to flip pages · Drag tabs to detach · Drop on tiles to merge" : "Drag tabs to detach · Drop on same-color tiles to merge"}</div>
          </div>
        </div>
      </DataProviderContext.Provider>
    </PharmIDEContext.Provider>
  );
}
