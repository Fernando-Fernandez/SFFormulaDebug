***Formula Debugger for Salesforce (Chrome Extension)***

**Overview**
- **Goal:** Inspect, test, and debug Salesforce formulas directly in the Lightning formula editor.
- **What it does:** Injects a lightweight debugger UI on Salesforce formula edit pages that parses the formula, lets you enter sample values, and shows step-by-step evaluation and the final result — all locally in your browser.

**Features**
- **Inline UI:** Adds a “Formula Debugger” panel under the `CalculatedFormula` editor in Salesforce.
- **Parser + evaluator:** Tokenizes and parses formulas, then evaluates them with your sample inputs.
- **Step-by-step:** Displays intermediate calculation steps and their results to aid understanding.
- **Variables input:** Detects field references and creates inputs to try different values.
- **Date support:** Handles date comparisons and simple arithmetic (e.g., date ± days).
- **Error reporting:** Shows parse/evaluation errors with helpful messages.

**Supported Syntax (Highlights)**
- **Operators:** `+ - * / = != <> < <= > >= && ||`
- **Literals:** Numbers, single-quoted strings, double-quoted strings, `NULL`
- **Functions (examples):** `IF`, `CONTAINS`, `FIND`, `MID`, `FLOOR`, `CASE`, `AND`, `OR`, `NOT`, `ISPICKVAL`, `ISBLANK`, `NOW`
- Notes:
  - String concatenation uses `+`.
  - `NOW()` can be supplied via a datetime input; date ± number treats the number as days.
  - Unsupported functions will show a clear error.

**Installation**
- **Load unpacked:**
  - Open `chrome://extensions` in Chrome.
  - Enable “Developer mode”.
  - Click “Load unpacked” and select this project directory.
- Confirm the extension appears with its icon and popup (`popup.html:1`).

**Usage**
- **Navigate to a formula editor:** Open your Salesforce Lightning org and go to an Object’s Fields & Relationships. Create or edit a Formula field so the formula editor loads.
- **Debugger injection:** On pages containing the formula editor, the extension injects a “Formula Debugger” panel below it.
- **Analyze:**
  - Click “Run Debug” to parse the current formula.
  - Review detected variables and enter sample values.
  - Click “Calculate” to compute the result and see each step evaluated.
- **Troubleshooting:** If the panel doesn’t appear, reload the page after the editor fully loads. Some editors render inside iframes; the extension waits for them and injects the UI when accessible.

**Known Limitations**
- **Function coverage:** Only a subset of Salesforce functions is implemented. Unsupported functions throw an error.
- **Type coercion:** Numeric/string/date coercions follow JavaScript-like behavior and may differ from Salesforce edge cases.
- **Date math:** Date ± number treats the number as days; time zones use your browser locale.

**Tips**
- Start with a small formula (e.g., `IF(1=1, "yes", "no")`) and add complexity.
- Use the variables panel to iterate quickly without editing live fields.
- Watch for red error banners; they generally point to the first problematic token/operator.

**Support / Feedback**
- Open an issue or share feedback with steps, the formula you tried, and a screenshot of the debugger panel and any error shown.
