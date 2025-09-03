***Here’s the high-level flow of the extension and how its pieces work together.***

**Bootstrapping**

URL check: Loads only on formula-editing pages via urlMatchesFormulaEditor().

UI injection: Creates a “Run Formula Debugger” button and a #debugOutput container alongside the formula textarea (CalculatedFormula).

Session fetch: On “Run” click, queries the background script for host and sessionId (stored globally) to enable Tooling API calls.

**Parse & Analyze**

Parse formula: Reads the formula from #CalculatedFormula, tokenizes and parses it into an AST (Tokenizer + Parser).

Type inference: Runs annotateTypes(ast) to tag each node with resultType (Number, Text, Boolean, Date, DateTime, Unknown).

**Variables & steps:**

extractVariables(ast) finds field references (and special NOW()) and renders input controls.
extractCalculationSteps(ast) builds a list of sub-expressions to show “calculation steps”.

**UI controls:**

“Calculate Formula” button computes the result.

Toggle “Use Anonymous Apex for steps” chooses between local calculation or a single batched Apex run.

**Local Calculation Path**

Overall result: calculateFormula(ast, variables) computes locally (supports IF, CONTAINS, FIND, MID, FLOOR, CASE, AND/OR/NOT, ISPICKVAL, ISBLANK, NOW, DATE, DATEVALUE, operators).

Steps: updateStepsWithCalculation() iterates the extracted steps and computes each locally for display.

**Anonymous Apex Path (batched, single execution)**

Run ID: Generates a unique runId and creates a placeholder result element per step: #step-result-${runId}-${index}.

Apex build: buildAnonymousApexForSteps(steps, ast, doc, runId) constructs one Apex script that:
- Parses the full step expressions back to text with rebuildFormula.
- Infers return types from node.resultType and maps to FormulaEval.FormulaReturnType (Text, Decimal, Boolean, Date, DateTime).
- Infers the SObject (e.g., from URL path .../ObjectManager/Account/...) and populates field assignments from the UI, converting values to Apex literals (Date.newInstance, DateTime.newInstanceGMT, numbers, booleans, strings).
- Logs each step result: System.debug('SFDBG|<runId>|<index>|' + String.valueOf(result)).
- Apex execution: Calls calculateFormulaViaAnonymousApex(apex, runId, doc) which delegates to ToolingAPIHandler.

**Tooling API Handling**

- Ensure Trace logs:
ensureActiveTraceFlag() gets current user (/chatter/users/me), queries TraceFlag for active Start/Expiration, and if needed:
ensureDebugLevel() queries/creates a DebugLevel (e.g., DeveloperName SFFormulaDebug).
- Creates a TraceFlag for 5 minutes (USER_DEBUG).

**Execute + log fetch:**

- executeAnonymous(...): Calls /tooling/executeAnonymous and, on success, waits briefly.
- retrieveDebugLogId(...): Queries latest ApexLog (optionally filters by length).
- retrieveDebugLogBody(...): Downloads log body.

**Parse + display:**

- parseApexLog(apexLog, runId) extracts all “SFDBG|<runId>|<index>|<value>” records (accounts for HTML-escaped pipes) and a fallback first USER_DEBUG message if no markers.
- displayParsedResults(parsed, doc) updates any matching #step-result-<runId>-<index> elements; otherwise returns the fallback string for generic use.

**Anonymous Apex for full formula**

createAnonymousApexFormula() builds a single formula evaluation:
- Escapes the formula text into Apex.
- Infers SObject type from URL.
- Infers return type by parsing + annotateTypes.
- Converts UI field values to Apex literals and calls:
- Formula.builder().withFormula(...).withType(...).withReturnType(...).build()
- System.debug(ff.evaluate(new SObject(assignments...)))

**Data Types & Display**

- Type-aware steps: The steps list shows each expression with -> <Type>.
- Inputs: Variables include a special NOW() control (datetime-local) and text inputs for fields.
- Results: Dates render via toLocaleString(), numbers respect precision.

**Testing (Node.js native)**

- Tokenizer tests: Validate token stream, comments, operators, parentheses errors.
- Parser tests: Validate AST shapes, precedence, functions, error conditions.
- Tooling API handler tests: Mock fetch:
Ensuring trace flag creation flow works.

SFDBG marker parsing updates a stub document.
Fallback path returns first USER_DEBUG.
Content script guarded for Node: No DOM code runs on require; module.exports provides Tokenizer, Parser, ToolingAPIHandler.