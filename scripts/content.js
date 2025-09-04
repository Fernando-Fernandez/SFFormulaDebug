const GETHOSTANDSESSION = "getHostSession";
const TOOLING_API_VERSION = 'v57.0';

var host, sessionId;

// UIBootstrap
//
// Small helper that decides when the Formula Debugger UI should be injected
// into the Salesforce formula editor page and wires the Run button to the
// debugging flow. It safely no-ops when running under Node (tests) where no
// `window`/`document` are available.
//
// Constructor options (all optional, mainly for tests):
// - doc: Document to operate on (defaults to window.document)
// - win: Window for location checks (defaults to window)
// - chromeRuntime: chrome.runtime for background messaging
// - onRunDebug: callback invoked after host/session are fetched

class UIBootstrap {
    constructor({ doc = (typeof window !== 'undefined' ? window.document : null),
                  win = (typeof window !== 'undefined' ? window : null),
                  chromeRuntime = (typeof chrome !== 'undefined' ? chrome.runtime : null),
                  onRunDebug = null } = {}) {
        this.doc = doc;
        this.win = win;
        this.chromeRuntime = chromeRuntime;
        // Default action triggers the FormulaUI runner with this document
        this.onRunDebug = onRunDebug || (() => FormulaUI.run(this.doc));
        this._mounted = false;
    }

    // Entry point — waits for the editor element and injects the UI once
    init() {
        if (!this.doc || !this.win) return;

        if (this.locationMatchesFormulaEditor()) {
            if (this.win === this.win.top) {
                this.waitForIframeAndElement();
            } else {
                this.waitForElement('CalculatedFormula', () => this.injectUI());
            }
            return;
        }

        // Flow Builder context: heuristically watch for a likely formula textarea
        if (this.locationMatchesFlowEditor()) {
            const selectors = [
                '#CalculatedFormula',
                'textarea[name="CalculatedFormula"]',
                'textarea[aria-label*="formula" i]',
                'textarea[placeholder*="formula" i]'
            ];
            this.waitForAnySelector(selectors, (el) => this.injectUI(el));
            return;
        }
    }

    // Returns true when the current URL looks like the standard formula editor
    locationMatchesFormulaEditor() {
        try { return this.win && this.win.location && this.win.location.href.includes('/e?'); }
        catch { return false; }
    }

    // Returns true when the current URL looks like the Flow Builder app
    locationMatchesFlowEditor() {
        try {
            const href = this.win && this.win.location ? this.win.location.href : '';
            return href.includes('/builder_platform_interaction/flowBuilder.app');
        } catch { return false; }
    }

    //
    // Observes DOM mutations until an element with the given id exists,
    // then invokes the provided callback exactly once.
    //
    waitForElement(elementId, callback) {
        const element = this.doc.getElementById(elementId);
        if (element) { callback(); return; }

        const observer = new MutationObserver((mutations, obs) => {
            const el = this.doc.getElementById(elementId);
            if (el) { obs.disconnect(); callback(); }
        });
        observer.observe(this.doc, { childList: true, subtree: true });
    }

    // Waits for any of the provided CSS selectors to match; passes the element to callback
    waitForAnySelector(selectors, callback) {
        const tryFind = () => {
            for (const sel of selectors) {
                try {
                    const el = this.doc.querySelector(sel);
                    if (el) return el;
                } catch (_) { /* ignore invalid selectors */ }
            }
            return null;
        };

        const found = tryFind();
        if (found) { callback(found); return; }

        const observer = new MutationObserver((mutations, obs) => {
            const el = tryFind();
            if (el) { obs.disconnect(); callback(el); }
        });
        observer.observe(this.doc, { childList: true, subtree: true });
    }

    //
    // Polls for the formula textarea from the top window. This avoids
    // cross-origin iframe access while still discovering the target element.
    //
    waitForIframeAndElement() {
        const checkForElement = () => {
            // Check in main document first
            let element = this.doc.getElementById('CalculatedFormula');
            if (element) { this.injectUI(); return; }
            // Retry if not found (iframes are cross-origin and inaccessible here)
            setTimeout(checkForElement, 500);
        };
        checkForElement();
    }

    //
    // Asks the extension background for the current org host + session id so
    // Tooling API calls can be made later. Safe to call when chrome.runtime
    // is unavailable (e.g., during tests).
    //
    async fetchHostAndSession() {
        if (!this.chromeRuntime) return;
        return new Promise(resolve => {
            const getHostMessage = { message: GETHOSTANDSESSION, url: (this.win ? this.win.location.href : '') };
            this.chromeRuntime.sendMessage(getHostMessage, resultData => {
                host = resultData && resultData.domain; // global vars used elsewhere
                sessionId = resultData && resultData.session;
                resolve({ host, sessionId });
            });
        });
    }

    //
    // Mounts the Formula Debugger controls next to the formula textarea,
    // wiring the Run button to fetch host/session and kick off parsing.
    //
    injectUI(targetEl = null) {
        if (this._mounted) return;
        const formulaTextarea = targetEl || this.doc.getElementById('CalculatedFormula');
        if (!formulaTextarea) return;
        if (this.doc.getElementById('formulaDebugger')) return;

        const debuggerDiv = this.doc.createElement('div');
        debuggerDiv.id = 'formulaDebugger';
        debuggerDiv.style.cssText = 'margin-top: 10px; padding: 10px; border: 1px solid #ccc; background: #f9f9f9; font-family: Arial, sans-serif;';
        debuggerDiv.innerHTML = `
            <button id="runDebug" type="button" style="padding: 5px 10px;">Run Formula Debugger</button>
            <div id="debugOutput">Debug output will appear here once implemented.</div>
        `;
        formulaTextarea.parentNode.insertBefore(debuggerDiv, formulaTextarea.nextSibling);

        const btn = this.doc.getElementById('runDebug');
        if (btn) {
            btn.addEventListener('click', async () => {
                await this.fetchHostAndSession();
                this.onRunDebug();
            });
        }
        this._mounted = true;
    }
}

class Tokenizer {
    //
    // Tokenizer
    //
    // Lightweight regex-based tokenizer for Salesforce formulas. Produces a
    // stream of tokens with `tokenType` and `token` fields. It tracks
    // parentheses balance to surface helpful error messages.
    //
    // Note: Whitespace and comment tokens are generated but filtered out by
    // the Parser before parsing begins.
    //
    static TOKEN_PATTERNS = [
        [ /^\s+/, 'WHITESPACE' ],
        [ /^"[^"]*"/, 'DOUBLE_QUOTE_STRING' ],
        [ /^\d+/, 'NUMBER' ],
        [ /^'[^']*'/, 'STRING' ],
        [ /^\/\/.*/, 'SINGLE_LINE_COMMENT' ],
        [ /^\/\*[\s\S]*?\*\//, 'MULTI_LINE_COMMENT' ],
        [ /^[+\-]/, 'ADDITIVE_OPERATOR' ],
        [ /^[*\/]/, 'MULTIPLICATIVE_OPERATOR' ],
        [ /^[()]/, 'PARENTHESIS' ],
        [ /^[{}]/, 'BRACES' ],
        [ /^,/, 'COMMA' ],
        [ /^&&/, 'AND' ],
        [ /^\|\|/, 'OR' ],
        [ /^=/, 'EQUAL' ],
        [ /^!=/, 'NOT_EQUAL' ],
        [ /^<>/, 'NOT_EQUAL' ],
        [ /^<=/, 'LESS_THAN_OR_EQUAL' ],
        [ /^>=/, 'GREATER_THAN_OR_EQUAL' ],
        [ /^</, 'LESS_THAN' ],
        [ /^>/, 'GREATER_THAN' ],
        [ /^NULL\b/i, 'NULL' ],
        [ /^[a-zA-Z_]\w*/, 'IDENTIFIER' ]
    ];

    // Resets internal state to begin tokenizing the provided expression
    initialize(inputString) {
        this._expression = inputString;
        this._currentPos = 0;
        this._parenStack = [];
    }

    // True when more tokens can be produced
    hasMoreTokens() {
        return this._currentPos < this._expression.length;
    }

    //
    // Returns the next token object or null when input is exhausted.
    // Throws with position context on unexpected characters or unbalanced
    // closing parenthesis.
    //
    getNextToken() {
        if (!this.hasMoreTokens()) {
            return null;
        }

        const remainingPart = this._expression.slice(this._currentPos);

        for (const [regExpression, tokenType] of Tokenizer.TOKEN_PATTERNS) {
            const token = this.findMatch(regExpression, remainingPart);
            if (token != null) {
                const tokenStartPos = this._currentPos;
                this._currentPos += token.length;

                if (token === '(') {
                    this._parenStack.push(tokenStartPos);
                } else if (token === ')') {
                    if (this._parenStack.length === 0) {
                        const expressionSnippet = this._expression.slice(Math.max(0, tokenStartPos - 10), tokenStartPos + 10);
                        throw new Error(`Unexpected closing parenthesis at position ${tokenStartPos + 1}: ')' ` 
                                        + `without matching '('. Near: '${expressionSnippet}'`);
                    }
                    this._parenStack.pop();
                }

                return { tokenType, token };
            }
        }

        const pos = this._currentPos + 1;
        const expressionSnippet = this._expression.slice(Math.max(0, pos - 10), pos + 10);
        throw new Error(`Unexpected character at position ${pos}: '${remainingPart[0]}'. Near: '${expressionSnippet}'`);
    }

    // Matches a single token pattern at the beginning of the remaining text
    findMatch(regExpression, remainingPart) {
        const theMatch = remainingPart.match(regExpression);
        if (!theMatch) {
            return null;
        }
        return theMatch[0];
    }

    // Throws if there are any unmatched opening parentheses left
    checkParenthesesBalance() {
        if (this._parenStack.length > 0) {
            const lastOpenPos = this._parenStack[this._parenStack.length - 1] + 1;
            const expressionSnippet = this._expression.slice(Math.max(0, lastOpenPos - 10), lastOpenPos + 10);
            throw new Error(`Missing closing parenthesis for opening parenthesis at position ${lastOpenPos}. `
                            + `Near: '${expressionSnippet}'`);
        }
    }
}

class Parser {
    //
    // Parser
    //
    // Simple recursive-descent parser for a useful subset of Salesforce
    // formula syntax. It handles literals, identifiers (fields), function
    // calls, parentheses, arithmetic (+ - * /), logical (&& ||), and
    // comparison operators (= != <> < > <= >=).
    //
    // Produces an AST with nodes of shape:
    // - { type: 'Literal', value: any }
    // - { type: 'Field', name: string }
    // - { type: 'Function', name: string, arguments: AST[] }
    // - { type: 'Operator', operator: string, left: AST, right: AST }
    //
    constructor() {
        this._string = '';
        this._tokenizer = new Tokenizer();
        this._tokens = [];
        this._currentIndex = 0;
    }

    // Tokenizes input, filters trivia, checks parens, returns parsed AST
    parse(string) {
        this._string = string;
        this._tokenizer.initialize(this._string);
        this._tokens = [];
        this._currentIndex = 0;

        while (this._tokenizer.hasMoreTokens()) {
            const token = this._tokenizer.getNextToken();
            if (token && token.tokenType !== 'WHITESPACE' && 
                token.tokenType !== 'SINGLE_LINE_COMMENT' && 
                token.tokenType !== 'MULTI_LINE_COMMENT') {
                this._tokens.push(token);
            }
        }

        this._tokenizer.checkParenthesesBalance();

        return this.parseExpression();
    }

    // Returns the current token without consuming it (or null)
    peek() {
        return this._currentIndex < this._tokens.length ? this._tokens[this._currentIndex] : null;
    }

    //
    // Consumes and returns the current token. When expectedType is provided,
    // throws if the token type does not match.
    //
    consume(expectedType = null) {
        const token = this.peek();
        if (!token) {
            throw new Error('Unexpected end of input');
        }
        if (expectedType && token.tokenType !== expectedType) {
            throw new Error(`Expected ${expectedType} at ${this._currentIndex}, got ${token.tokenType}`);
        }
        this._currentIndex++;
        return token;
    }

    // Lowest-precedence parse: handles logical AND/OR
    parseExpression() {
        let node = this.parseEquality();
        while (this.peek() && (this.peek().token === '&&' || this.peek().token === '||')) {
            const operator = this.consume().token;
            const right = this.parseEquality();
            node = { type: 'Operator', operator, left: node, right };
        }
        return node;
    }

    // Next level: comparison operators (= != <> < > <= >=)
    parseEquality() {
        let node = this.parseTerm();
        while (this.peek() && (
            this.peek().token === '=' ||
            this.peek().token === '!=' ||
            this.peek().token === '<>' ||
            this.peek().token === '<' ||
            this.peek().token === '>' ||
            this.peek().token === '<=' ||
            this.peek().token === '>='
        )) {
            const operator = this.consume().token;
            const right = this.parseTerm();
            node = { type: 'Operator', operator, left: node, right };
        }
        return node;
    }

    // Addition/subtraction level
    parseTerm() {
        let node = this.parseFactor();
        while (this.peek() && (this.peek().token === '+' || this.peek().token === '-')) {
            const operator = this.consume().token;
            const right = this.parseFactor();
            node = { type: 'Operator', operator, left: node, right };
        }
        return node;
    }

    // Multiplication/division level
    parseFactor() {
        let node = this.parsePrimary();
        while (this.peek() && (this.peek().token === '*' || this.peek().token === '/')) {
            const operator = this.consume().token;
            const right = this.parsePrimary();
            node = { type: 'Operator', operator, left: node, right };
        }
        return node;
    }

    // Literals, fields, function calls, and parenthesized expressions
    parsePrimary() {
        const token = this.peek();
        if (!token) {
            throw new Error('Unexpected end of input');
        }

        if (token.tokenType === 'NUMBER') {
            return { type: 'Literal', value: parseFloat(this.consume().token) };
        } else if (token.tokenType === 'STRING' || token.tokenType === 'DOUBLE_QUOTE_STRING') {
            return { type: 'Literal', value: this.consume().token.slice(1, -1) };
        } else if (token.tokenType === 'NULL') {
            this.consume();
            return { type: 'Literal', value: null };
        } else if (token.tokenType === 'IDENTIFIER') {
            const name = this.consume().token;
            if (this.peek() && this.peek().token === '(') {
                this.consume('PARENTHESIS');
                const args = [];
                while (this.peek() && this.peek().token !== ')') {
                    args.push(this.parseExpression());
                    if (this.peek() && this.peek().token === ',') {
                        this.consume('COMMA');
                    } else {
                        break;
                    }
                }
                this.consume('PARENTHESIS');
                return { type: 'Function', name, arguments: args };
            } else {
                return { type: 'Field', name };
            }
        } else if (token.token === '(') {
            this.consume('PARENTHESIS');
            const expr = this.parseExpression();
            this.consume('PARENTHESIS');
            return expr;
        } else {
            throw new Error(`Unexpected token: ${token.token}`);
        }
    }
}

// ToolingAPIHandler
//
// Thin wrapper around Salesforce Tooling API endpoints that this extension
// needs to drive Anonymous Apex execution and correlate debug logs back to
// UI steps. Responsibilities:
// - Ensure a DebugLevel + TraceFlag exist for the current user
// - Execute Anonymous Apex with the provided source
// - Retrieve the most recent Apex log body
// - Parse SFDBG-delimited USER_DEBUG lines and display results
class ToolingAPIHandler {
    constructor(host, sessionId, apiVersion = TOOLING_API_VERSION) {
        this.host = host;
        this.sessionId = sessionId;
        this.apiVersion = apiVersion;
        // Store the most recent parsed results for access by callers
        this.lastParsedResults = null;
        this.lastRunId = null;
    }

    //
    // Builds a fully-qualified endpoint and standard request with auth headers.
    // Pass a suffix like '/tooling/query/?q=...' and optional options:
    //  - method: HTTP method (default 'GET')
    //  - json: object to JSON.stringify into the request body
    //
    buildRequest(suffix, { method = 'GET', json = null } = {}) {
        const base = `https://${this.host}/services/data/${this.apiVersion}`;
        const normalized = suffix.startsWith('/') ? suffix : `/${suffix}`;
        const endpoint = `${base}${normalized}`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.sessionId}`
        };
        const request = { method, headers };
        if (json !== null && json !== undefined) {
            request.body = JSON.stringify(json);
        }
        return { endpoint, request };
    }

    // Encodes Apex for inclusion in a GET querystring
    encodeAnonymous(anonymousApex) {
        return encodeURI(anonymousApex)
            .replaceAll('(', '%28')
            .replaceAll(')', '%29')
            .replaceAll(';', '%3B')
            .replaceAll('+', '%2B');
    }

    //
    // Runs Anonymous Apex via Tooling API, waits briefly for the log, and
    // then attempts to retrieve and display the correlated results.
    // Returns truthy when results are displayed, null/false otherwise.
    //
    async executeAnonymous(anonymousApex, runId = null, doc = null) {
        // Ensure there is an active TraceFlag for the current user
        try {
            await this.ensureActiveTraceFlag();
        } catch (e) {
            console.warn('Could not ensure TraceFlag:', e);
        }
        const { endpoint, request } = this.buildRequest(`/tooling/executeAnonymous/?anonymousBody=${this.encodeAnonymous(anonymousApex)}`);

        try {
            const response = await fetch(endpoint, request);
            const data = await response.json();

            if (Array.isArray(data) && data[0].errorCode) {
                console.error('Could not execute Anonymous Apex: ' + data[0].message);
                return null;
            }

            if (!data.success) {
                console.error('Apex execution failed: ' + data.compileProblem);
                console.error('Apex execution stack: ' + data.exceptionStackTrace);
                console.error('Apex execution exception: ' + data.exceptionMessage);
                return null;
            }

            await this.sleep(750);
            return this.retrieveDebugLogId(runId, doc);
        } catch (err) {
            console.error('Network or parsing error:', err);
        }
        return null;
    }

    // Ensures a valid TraceFlag exists for the current user for ~5 minutes
    async ensureActiveTraceFlag() {
        const userId = await this.getCurrentUserId();
        if (!userId) return false;

        // Check for existing active TraceFlag
        const now = new Date();
        const q = encodeURIComponent(`SELECT Id, StartDate, ExpirationDate, DebugLevelId FROM TraceFlag WHERE TracedEntityId='${userId}' ORDER BY ExpirationDate DESC`);
        const { endpoint: tfEndpoint, request: tfRequest } = this.buildRequest(`/tooling/query/?q=${q}`);
        try {
            const resp = await fetch(tfEndpoint, tfRequest);
            const data = await resp.json();
            if (data && data.records && data.records.length) {
                const active = data.records.find(r => {
                    const start = r.StartDate ? new Date(r.StartDate) : null;
                    const exp = r.ExpirationDate ? new Date(r.ExpirationDate) : null;
                    return (!start || start <= now) && exp && exp > now;
                });
                if (active) return true;
            }
        } catch (e) {
            console.warn('TraceFlag query failed', e);
        }

        // Ensure a DebugLevel exists
        const debugLevelId = await this.ensureDebugLevel();
        if (!debugLevelId) return false;

        // Create TraceFlag for next 5 minutes
        const start = new Date();
        const exp = new Date(start.getTime() + 5 * 60 * 1000);
        const body = {
            TracedEntityId: userId,
            DebugLevelId: debugLevelId,
            LogType: 'USER_DEBUG',
            StartDate: start.toISOString(),
            ExpirationDate: exp.toISOString()
        };
        const { endpoint: createEndpoint, request: createRequest } = this.buildRequest('/tooling/sobjects/TraceFlag', { method: 'POST', json: body });
        try {
            const createResp = await fetch(createEndpoint, createRequest);
            const res = await createResp.json();
            if (res && res.success) return true;
            // Some orgs return id without success; treat as ok
            if (res && res.id) return true;
            console.warn('TraceFlag create failed', res);
        } catch (e) {
            console.warn('TraceFlag create error', e);
        }
        return false;
    }

    // Finds or creates the DebugLevel used by this extension
    async ensureDebugLevel() {
        const name = 'SFFormulaDebug';
        const q = encodeURIComponent(`SELECT Id FROM DebugLevel WHERE DeveloperName='${name}'`);
        const { endpoint: dlEndpoint, request: dlRequest } = this.buildRequest(`/tooling/query/?q=${q}`);
        try {
            const resp = await fetch(dlEndpoint, dlRequest);
            const data = await resp.json();
            if (data && data.records && data.records.length) {
                return data.records[0].Id;
            }
        } catch (e) {
            console.warn('DebugLevel query failed', e);
        }

        // Create DebugLevel
        const body = {
            DeveloperName: name,
            MasterLabel: name,
            ApexCode: 'DEBUG',
            ApexProfiling: 'INFO',
            Callout: 'INFO',
            Database: 'INFO',
            System: 'DEBUG',
            Validation: 'INFO',
            Visualforce: 'INFO',
            Workflow: 'INFO'
        };
        try {
            const { endpoint: createEndpoint, request: createRequest } = this.buildRequest('/tooling/sobjects/DebugLevel', { method: 'POST', json: body });
            const resp = await fetch(createEndpoint, createRequest);
            const data = await resp.json();
            if (data && data.id) return data.id;
        } catch (e) {
            console.warn('DebugLevel create failed', e);
        }
        return null;
    }

    // Returns the current user's Id via Chatter users/me
    async getCurrentUserId() {
        const { endpoint, request } = this.buildRequest('/chatter/users/me');
        try {
            const resp = await fetch(endpoint, request);
            const data = await resp.json();
            // Chatter users/me includes id
            if (data && data.id) return data.id;
        } catch (e) {
            console.warn('Could not get current user id', e);
        }
        return null;
    }

    // Queries the most recent ApexLog id and fetches its body
    async retrieveDebugLogId(runId = null, doc = null) {
        const { endpoint, request } = this.buildRequest('/tooling/query/?q=SELECT Id FROM ApexLog WHERE LogLength > 10000 ORDER BY StartTime DESC LIMIT 1');

        try {
            const response = await fetch(endpoint, request);
            const data = await response.json();

            if (Array.isArray(data) && data[0].errorCode) {
                console.error('Could not find Apex Log: ' + data[0].message);
                return null;
            }
            if (!data.records || data.records.length == 0) {
                console.error('No Apex logs found');
                return null;
            }

            return this.retrieveDebugLogBody(data.records[0].Id, runId, doc);
        } catch (err) {
            console.error('Network or parsing error:', err);
        }
        return null;
    }

    // Downloads a log body by id, parses markers, and updates the UI
    async retrieveDebugLogBody(apexLogId, runId = null, doc = null) {
        const { endpoint, request } = this.buildRequest(`/tooling/sobjects/ApexLog/${apexLogId}/Body`);

        try {
            const response = await fetch(endpoint, request);
            const apexLog = await response.text();
            const parsed = this.parseApexLog(apexLog, runId);
            // Persist parsed results for later inspection by UI code
            this.lastParsedResults = parsed;
            this.lastRunId = runId;
            const displayed = this.displayParsedResults(parsed, doc);
            if (displayed) return true;
            return parsed.fallback;
        } catch (err) {
            console.error('Network or parsing error:', err);
        }
        return null;
    }

    //
    // Parses a full Apex log string and extracts SFDBG-delimited results.
    // The payload format is: SFDBG|<runId>|<stepIndex>|<value>
    // Returns { matches: {rid, stepIndex, value}[], fallback: string|null }.
    //
    parseApexLog(apexLog, runId = null) {
        const logLines = apexLog.split('\n');
        const pipe = '&#124;';
        const marker = 'SFDBG' + pipe;
        const matches = [];
        let fallback = null;

        for (let line of logLines) {
            if (line.includes('USER_DEBUG')) {
                // Capture first USER_DEBUG as fallback if no markers found
                if (fallback === null) {
                    const m = line.match(/^.+?\|DEBUG\|(.*)/);
                    if (m) fallback = m[1];
                }
                if (line.includes(marker)) {
                    const msgMatch = line.match(/\|DEBUG\|(.*)$/);
                    const msg = msgMatch ? msgMatch[1] : '';
                    const idx = msg.indexOf(marker);
                    if (idx >= 0) {
                        const payload = msg.substring(idx + marker.length);
                        const parts = payload.split(pipe);
                        const rid = parts[0];
                        const stepIndex = parts[1];
                        const value = parts.slice(2).join(pipe);
                        if (!runId || rid === runId) {
                            matches.push({ rid, stepIndex, value });
                        }
                    }
                }
            }
        }

        return { matches, fallback };
    }

    // Sleep helper for throttling Tooling API polling
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Display parsed SFDBG results into the provided document
    displayParsedResults(parsed, doc) {
        const ctxDoc = doc || (typeof document !== 'undefined' ? document : null);
        if (!ctxDoc || !parsed || !parsed.matches) return false;
        let any = false;
        for (const { rid, stepIndex, value } of parsed.matches) {
            const elId = `step-result-${rid}-${stepIndex}`;
            const el = ctxDoc.getElementById(elId);
            if (el) {
                el.textContent = `= ${value}`;
                any = true;
            }
        }
        return any;
    }
}

//
// FormulaEngine
//
// Pure, stateless helpers for working with Salesforce-style formulas.
// Responsibilities:
// - Build an AST from a formula string (via Parser)
// - Infer/annotate result types for AST nodes
// - Evaluate ASTs locally with supplied variable values
// - Rebuild a formula string from an AST
// - Extract variables and calculation "steps" for UI display
//
// Notes:
// - All methods are static to keep usage simple and side‑effect free.
// - Date handling supports both Date and DateTime semantics as needed.
//
class FormulaEngine {
    static RESULT_TYPE = {
        Text: 'Text',
        Number: 'Number',
        Boolean: 'Boolean',
        Date: 'Date',
        DateTime: 'DateTime',
        Unknown: 'Unknown'
    };
    // Parses a formula string into an AST using the recursive‑descent Parser
    static parse(formula) {
        const p = new Parser();
        return p.parse(formula);
    }

    // Walks the AST to collect referenced field names and special tokens (e.g., NOW())
    static extractVariables(ast) {
        const variables = new Set();
        function traverse(node) {
            if (!node) return;
            switch (node.type) {
                case 'Field':
                    variables.add(node.name);
                    break;
                case 'Function':
                    if (node.name.toUpperCase() === 'NOW') {
                        variables.add('NOW()');
                    }
                    node.arguments.forEach(arg => traverse(arg));
                    break;
                case 'Operator':
                    traverse(node.left);
                    traverse(node.right);
                    break;
                case 'Literal':
                    break;
                default:
                    throw new Error(`Unknown AST node type: ${node.type}`);
            }
        }
        traverse(ast);
        return Array.from(variables);
    }

    // Maps a literal JS value to a formula result type
    static inferLiteralResultType(value) {
        if (value === null || value === undefined) return FormulaEngine.RESULT_TYPE.Unknown;
        if (typeof value === 'number') return FormulaEngine.RESULT_TYPE.Number;
        if (typeof value === 'string') return FormulaEngine.RESULT_TYPE.Text;
        if (this.isDate(value)) return FormulaEngine.RESULT_TYPE.DateTime;
        return FormulaEngine.RESULT_TYPE.Unknown;
    }

    // Best‑effort unification of two inferred types (used by IF/CASE, operators)
    static unifyTypes(a, b) {
        if (!a) return b || FormulaEngine.RESULT_TYPE.Unknown;
        if (!b) return a || FormulaEngine.RESULT_TYPE.Unknown;
        if (a === b) return a;
        if (a === FormulaEngine.RESULT_TYPE.Text || b === FormulaEngine.RESULT_TYPE.Text) return FormulaEngine.RESULT_TYPE.Text;
        if ((a === FormulaEngine.RESULT_TYPE.Date && b === FormulaEngine.RESULT_TYPE.Number) || (b === FormulaEngine.RESULT_TYPE.Date && a === FormulaEngine.RESULT_TYPE.Number)) return FormulaEngine.RESULT_TYPE.Date;
        if ((a === FormulaEngine.RESULT_TYPE.DateTime && b === FormulaEngine.RESULT_TYPE.Number) || (b === FormulaEngine.RESULT_TYPE.DateTime && a === FormulaEngine.RESULT_TYPE.Number)) return FormulaEngine.RESULT_TYPE.DateTime;
        if (a === FormulaEngine.RESULT_TYPE.Unknown) return b;
        if (b === FormulaEngine.RESULT_TYPE.Unknown) return a;
        return FormulaEngine.RESULT_TYPE.Unknown;
    }

    // Annotates AST nodes in place with a best‑guess `resultType` using optional sample values
    static annotateTypes(ast, sampleVariables = {}) {
        const infer = (node) => {
            if (!node) return FormulaEngine.RESULT_TYPE.Unknown;
            switch (node.type) {
                case 'Literal': {
                    node.resultType = this.inferLiteralResultType(node.value);
                    return node.resultType;
                }
                case 'Field': {
                    const v = sampleVariables[node.name];
                    if (v === undefined || v === null || v === '') {
                        node.resultType = FormulaEngine.RESULT_TYPE.Unknown;
                    } else if (typeof v === 'number') {
                        node.resultType = FormulaEngine.RESULT_TYPE.Number;
                    } else if (this.isDate(v)) {
                        node.resultType = FormulaEngine.RESULT_TYPE.DateTime;
                    } else if (typeof v === 'string') {
                        const dt = this.toDate(v);
                        if (dt) {
                            node.resultType = v.includes('T') ? FormulaEngine.RESULT_TYPE.DateTime : FormulaEngine.RESULT_TYPE.Date;
                        } else if (!isNaN(parseFloat(v))) {
                            node.resultType = FormulaEngine.RESULT_TYPE.Number;
                        } else {
                            node.resultType = FormulaEngine.RESULT_TYPE.Text;
                        }
                    } else {
                        node.resultType = FormulaEngine.RESULT_TYPE.Unknown;
                    }
                    return node.resultType;
                }
                case 'Operator': {
                    const lt = infer(node.left);
                    const rt = infer(node.right);
                    switch (node.operator) {
                        case '&&':
                        case '||':
                        case '=':
                        case '!=':
                        case '<>':
                        case '<':
                        case '>':
                        case '<=':
                        case '>=':
                            node.resultType = FormulaEngine.RESULT_TYPE.Boolean;
                            break;
                        case '+': {
                            if (lt === FormulaEngine.RESULT_TYPE.Text || rt === FormulaEngine.RESULT_TYPE.Text) node.resultType = FormulaEngine.RESULT_TYPE.Text;
                            else if (lt === FormulaEngine.RESULT_TYPE.Date && rt === FormulaEngine.RESULT_TYPE.Number) node.resultType = FormulaEngine.RESULT_TYPE.Date;
                            else if (lt === FormulaEngine.RESULT_TYPE.Number && rt === FormulaEngine.RESULT_TYPE.Date) node.resultType = FormulaEngine.RESULT_TYPE.Date;
                            else if (lt === FormulaEngine.RESULT_TYPE.DateTime && rt === FormulaEngine.RESULT_TYPE.Number) node.resultType = FormulaEngine.RESULT_TYPE.DateTime;
                            else if (lt === FormulaEngine.RESULT_TYPE.Number && rt === FormulaEngine.RESULT_TYPE.DateTime) node.resultType = FormulaEngine.RESULT_TYPE.DateTime;
                            else node.resultType = FormulaEngine.RESULT_TYPE.Number;
                            break;
                        }
                        case '-': {
                            if ((lt === FormulaEngine.RESULT_TYPE.Date || lt === FormulaEngine.RESULT_TYPE.DateTime) && (rt === FormulaEngine.RESULT_TYPE.Date || rt === FormulaEngine.RESULT_TYPE.DateTime)) {
                                node.resultType = FormulaEngine.RESULT_TYPE.Number;
                            } else if ((lt === FormulaEngine.RESULT_TYPE.Date || lt === FormulaEngine.RESULT_TYPE.DateTime) && rt === FormulaEngine.RESULT_TYPE.Number) {
                                node.resultType = lt;
                            } else {
                                node.resultType = FormulaEngine.RESULT_TYPE.Number;
                            }
                            break;
                        }
                        case '*':
                        case '/':
                            node.resultType = FormulaEngine.RESULT_TYPE.Number;
                            break;
                        default:
                            node.resultType = FormulaEngine.RESULT_TYPE.Unknown;
                    }
                    return node.resultType;
                }
                case 'Function': {
                    const argTypes = node.arguments.map(arg => infer(arg));
                    node.resultType = this.functionReturnType(node.name, argTypes);
                    return node.resultType;
                }
                default:
                    node.resultType = FormulaEngine.RESULT_TYPE.Unknown;
                    return node.resultType;
            }
        };
        infer(ast);
        return ast;
    }

    // Returns the formula result type for a known function based on argument types
    static functionReturnType(name, argTypes) {
        const n = name.toUpperCase();
        switch (n) {
            case 'IF':
                return this.unifyTypes(argTypes[1], argTypes[2]);
            case 'CONTAINS':
                return FormulaEngine.RESULT_TYPE.Boolean;
            case 'FIND':
                return FormulaEngine.RESULT_TYPE.Number;
            case 'MID':
                return FormulaEngine.RESULT_TYPE.Text;
            case 'FLOOR':
                return FormulaEngine.RESULT_TYPE.Number;
            case 'CASE':
                if (argTypes.length >= 3) {
                    let t = FormulaEngine.RESULT_TYPE.Unknown;
                    for (let i = 2; i < argTypes.length; i += 2) {
                        t = this.unifyTypes(t, argTypes[i]);
                    }
                    if ((argTypes.length - 1) % 2 === 1) {
                        t = this.unifyTypes(t, argTypes[argTypes.length - 1]);
                    }
                    return t;
                }
                return FormulaEngine.RESULT_TYPE.Unknown;
            case 'AND':
            case 'OR':
            case 'NOT':
            case 'ISPICKVAL':
            case 'ISBLANK':
                return FormulaEngine.RESULT_TYPE.Boolean;
            case 'NOW':
                return FormulaEngine.RESULT_TYPE.DateTime;
            case 'DATE':
                return FormulaEngine.RESULT_TYPE.Date;
            case 'DATEVALUE':
                return FormulaEngine.RESULT_TYPE.Date;
            default:
                return FormulaEngine.RESULT_TYPE.Unknown;
        }
    }

    // Serializes an AST back into a human‑readable formula string
    static rebuild(ast) {
        if (!ast || !ast.type) return '';
        switch (ast.type) {
            case 'Function': {
                const args = ast.arguments.map(arg => this.rebuild(arg)).join(', ');
                return `${ast.name}(${args})`;
            }
            case 'Operator': {
                const left = this.rebuild(ast.left);
                const right = this.rebuild(ast.right);
                return `${left} ${ast.operator} ${right}`;
            }
            case 'Field':
                return ast.name;
            case 'Literal':
                if (ast.value === null) return 'null';
                if (typeof ast.value === 'string') return `"${ast.value}"`;
                return ast.value.toString();
            default:
                throw new Error(`Unknown AST node type: ${ast.type}`);
        }
    }

    // Attempts to normalize a value to a Date (Date or ISO/date‑like string)
    static toDate(value) {
        if (this.isDate(value)) return value;
        if (this.isDateString(value)) return new Date(value);
        return null;
    }
    // Type guards for date values/strings
    static isDate(value) { return value instanceof Date; }
    static isDateString(value) {
        if (typeof value !== 'string' || value.trim() === '') return false;
        const date = new Date(value);
        return !isNaN(date.getTime());
    }

    // Evaluates an AST with provided variable values (best‑effort local execution)
    static calculate(ast, variables = {}) {
        if (!ast) return null;
        switch (ast.type) {
            case 'Function': {
                const args = ast.arguments.map(arg => this.calculate(arg, variables));
                switch (ast.name.toUpperCase()) {
                    case 'IF': return args[0] ? args[1] : args[2];
                    case 'CONTAINS': {
                        const text = String(args[0] || '');
                        const substring = String(args[1] || '');
                        return text.includes(substring);
                    }
                    case 'FIND': {
                        const findText = String(args[1] || '');
                        const findSubstring = String(args[0] || '');
                        const startPos = args[2] ? parseInt(args[2]) - 1 : 0;
                        const pos = findText.indexOf(findSubstring, startPos);
                        return pos === -1 ? 0 : pos + 1;
                    }
                    case 'MID': {
                        const midText = String(args[0] || '');
                        const start = parseInt(args[1] || 1) - 1;
                        const length = parseInt(args[2] || 0);
                        return midText.substr(start, length);
                    }
                    case 'FLOOR': {
                        if (args.length !== 1) throw new Error('FLOOR requires exactly one argument');
                        const number = parseFloat(args[0]);
                        if (isNaN(number)) throw new Error('FLOOR argument must be numeric');
                        return Math.floor(number);
                    }
                    case "CASE": {
                        if (args.length < 4 || args.length % 2 === 1) {
                            throw new Error("CASE requires an expression, at least one value-result pair, "
                                            + "and a default value (even number of arguments)");
                        }
                        const expressionValue = args[0];
                        for (let i = 1; i < args.length - 1; i += 2) {
                            if (expressionValue === args[i]) {
                                return args[i + 1];
                            }
                        }
                        return args[args.length - 1];
                    }
                    case "AND": {
                        if (args.length === 0) {
                            throw new Error("AND requires at least one argument");
                        }
                        return args.every(arg => Boolean(arg));
                    }
                    case "OR": {
                        if (args.length === 0) {
                            throw new Error("OR requires at least one argument");
                        }
                        return args.some(arg => Boolean(arg));
                    }
                    case "NOT": {
                        if (args.length !== 1) {
                            throw new Error("NOT requires exactly one argument");
                        }
                        return !Boolean(args[0]);
                    }
                    case "ISPICKVAL": {
                        if (args.length !== 2) {
                            throw new Error("ISPICKVAL requires exactly two arguments: field and value");
                        }
                        const fieldValue = String(args[0] || "");
                        const picklistValue = String(args[1] || "");
                        return fieldValue === picklistValue;
                    }
                    case "ISBLANK": {
                        if (args.length !== 1) {
                            throw new Error("ISBLANK requires exactly one argument");
                        }
                        const value = args[0];
                        if (value === null || value === undefined) {
                            return true;
                        }
                        const stringValue = String(value).trim();
                        return stringValue === "";
                    }
                    case "NOW": {
                        if (args.length !== 0) {
                            throw new Error("NOW requires no arguments");
                        }
                        // For testing purposes, check if there's a test value provided
                        if (variables && variables['NOW()'] !== undefined) {
                            const testValue = variables['NOW()'];
                            if (testValue === '') {
                                return new Date();
                            }
                            const parsedDate = new Date(testValue);
                            if (isNaN(parsedDate.getTime())) {
                                throw new Error("Invalid date format for NOW() test value");
                            }
                            return parsedDate;
                        }
                        return new Date();
                    }
                    case "DATEVALUE": {
                        if (args.length !== 1) {
                            throw new Error("DATEVALUE requires exactly one argument");
                        }
                        if (args[0] === null || args[0] === undefined || String(args[0]).trim() === '') {
                            return null;
                        }
                        if (isDate(args[0])) {
                            const d0 = args[0];
                            return new Date(d0.getFullYear(), d0.getMonth(), d0.getDate());
                        }
                        if (typeof args[0] === 'string') {
                            const d1 = toDate(args[0]);
                            if (!d1) {
                                throw new Error("Invalid date format for DATEVALUE");
                            }
                            return new Date(d1.getFullYear(), d1.getMonth(), d1.getDate());
                        }
                        throw new Error("DATEVALUE argument must be a date/time or text");
                    }
                    case "DATE": {
                        if (args.length !== 3) {
                            throw new Error("DATE requires exactly three arguments: year, month, day");
                        }
                        const y = parseInt(args[0], 10);
                        const m = parseInt(args[1], 10);
                        const d = parseInt(args[2], 10);
                        if ([y, m, d].some(v => isNaN(v))) {
                            throw new Error("DATE arguments must be numeric");
                        }
                        if (m < 1 || m > 12) {
                            throw new Error("DATE month must be between 1 and 12");
                        }
                        if (d < 1 || d > 31) {
                            throw new Error("DATE day must be between 1 and 31");
                        }
                        // Construct at midnight local time
                        return new Date(y, m - 1, d);
                    }
                    default:
                        throw new Error(`This tool doesn't support the function ${ast.name}`);
                }
            }
            case 'Operator': {
                const left = this.calculate(ast.left, variables);
                const right = this.calculate(ast.right, variables);
                const leftDate = this.toDate(left);
                const rightDate = this.toDate(right);
                switch (ast.operator) {
                    case '+':
                        if (leftDate && typeof right === 'number') return new Date(leftDate.getTime() + (right * 24 * 60 * 60 * 1000));
                        if (typeof left === 'number' && rightDate) return new Date(rightDate.getTime() + (left * 24 * 60 * 60 * 1000));
                        return (parseFloat(left) || 0) + (parseFloat(right) || 0);
                    case '-':
                        if (leftDate && rightDate) {
                            const diffMs = leftDate.getTime() - rightDate.getTime();
                            return diffMs / (1000 * 60 * 60 * 24);
                        }
                        if (leftDate && typeof right === 'number') return new Date(leftDate.getTime() - (right * 24 * 60 * 60 * 1000));
                        return (parseFloat(left) || 0) - (parseFloat(right) || 0);
                    case '*':
                        return (parseFloat(left) || 0) * (parseFloat(right) || 0);
                    case '/': {
                        const divisor = parseFloat(right) || 0;
                        if (divisor === 0) throw new Error('Division by zero');
                        return (parseFloat(left) || 0) / divisor;
                    }
                    case '&&': return Boolean(left) && Boolean(right);
                    case '||': return Boolean(left) || Boolean(right);
                    case '=':
                        if (leftDate && rightDate) return leftDate.getTime() === rightDate.getTime();
                        return left === right;
                    case '<>':
                    case '!=':
                        if (leftDate && rightDate) return leftDate.getTime() !== rightDate.getTime();
                        return left !== right;
                    case '<':
                        if (leftDate && rightDate) return leftDate.getTime() < rightDate.getTime();
                        return (parseFloat(left) || 0) < (parseFloat(right) || 0);
                    case '>':
                        if (leftDate && rightDate) return leftDate.getTime() > rightDate.getTime();
                        return (parseFloat(left) || 0) > (parseFloat(right) || 0);
                    case '<=':
                        if (leftDate && rightDate) return leftDate.getTime() <= rightDate.getTime();
                        return (parseFloat(left) || 0) <= (parseFloat(right) || 0);
                    case '>=':
                        if (leftDate && rightDate) return leftDate.getTime() >= rightDate.getTime();
                        return (parseFloat(left) || 0) >= (parseFloat(right) || 0);
                    default:
                        throw new Error(`Unsupported operator: ${ast.operator}`);
                }
            }
            case 'Field': {
                const fieldValue = variables[ast.name] !== undefined ? variables[ast.name] : '';
                if (typeof fieldValue === 'string' && fieldValue.trim() !== '') {
                    const dateValue = this.toDate(fieldValue);
                    if (dateValue) {
                        return dateValue;
                    }
                }
                return fieldValue;
            }
            case 'Literal':
                return ast.value;
            default:
                throw new Error(`Unknown AST node type: ${ast.type}`);
        }
    }

    // Produces a de‑duplicated list of intermediate expressions (for step‑by‑step UI)
    static extractCalculationSteps(ast) {
        const steps = [];
        const seen = new Set();
        const traverse = (node) => {
            if (!node) return;
            switch (node.type) {
                case 'Function': {
                    node.arguments.forEach(arg => traverse(arg));
                    const expr = this.rebuild(node);
                    if (!seen.has(expr)) {
                        seen.add(expr);
                        steps.push({ expression: expr, node });
                    }
                    break;
                }
                case 'Operator': {
                    traverse(node.left);
                    traverse(node.right);
                    const opExpr = this.rebuild(node);
                    if (!seen.has(opExpr)) {
                        seen.add(opExpr); 
                        steps.push({ expression: opExpr, node });
                    }
                    break;
                }
                case 'Field':
                case 'Literal':
                    break;
                default:
                    throw new Error(`Unknown AST node type: ${node.type}`);
            }
        };
        traverse(ast);
        return steps;
    }
}

//
// FormulaUI
//
// Small UI helper focused on rendering formula analysis in the page:
// - Extracts the current formula from the editor
// - Renders variables, result panel, and calculation steps
// - Locally evaluates the formula or delegates step evaluation to Apex
//
// All methods are static and expect a `Document` to operate on.
//
class FormulaUI {
    // Entry point for running analysis: parses, annotates, and renders results
    static run(doc = (typeof window !== 'undefined' ? window.document : null)) {
        if (!doc) return;
        const formula = FormulaUI.extractFormulaContent(doc);
        const debugOutput = doc.getElementById('debugOutput');
        if (!debugOutput) {
            console.error('Debug output element not found.');
            return;
        }

        try {
            if (!formula || formula.trim() === '') {
                debugOutput.innerText = 'No formula to analyze';
                return;
            }

            const ast = FormulaEngine.parse(formula.trim());

            // annotate AST with inferred result types
            FormulaEngine.annotateTypes(ast);

            FormulaUI.displayDataStructure(ast, doc);

        } catch (error) {
            debugOutput.innerHTML = `<div style="color: red; padding: 10px; background: #ffe8e8; border: 1px solid #f44336; border-radius: 4px;">\n            <strong>Formula Analysis Error:</strong><br>${error.message}\n        </div>`;
        }
    }

    // Converts an AST to a Mermaid diagram and logs it for easy copy/paste
    // Example usage: FormulaUI.toMermaid(ast) -> logs a ```mermaid fenced block
    static toMermaid(ast, { fenced = true, results = null } = {}) {
        const lines = ['graph LR'];
        let counter = 0;
        const newId = () => `n${++counter}`;
        // Prepare lookup helpers for optional results
        let resultsByExpr = null;
        let resultsIsMapLike = false;
        if (results) {
            if (Array.isArray(results)) {
                resultsByExpr = new Map();
                for (const item of results) {
                    if (!item) continue;
                    if (Array.isArray(item) && item.length >= 2) {
                        resultsByExpr.set(String(item[0]), item[1]);
                    } else if (item.expression !== undefined) {
                        resultsByExpr.set(String(item.expression), item.result ?? item.value);
                    }
                }
            } else if (results instanceof Map) {
                resultsIsMapLike = true;
            } else if (typeof results === 'object') {
                resultsByExpr = new Map(Object.entries(results));
            }
        }
        // If no explicit results provided, try to use last Apex results captured by ToolingAPIHandler
        if (!results && FormulaUI.lastParsedResults && Array.isArray(FormulaUI.lastParsedResults.matches)) {
            try {
                const steps = FormulaEngine.extractCalculationSteps(ast);
                const indexToExpr = new Map();
                steps.forEach((s, i) => indexToExpr.set(i + 1, FormulaEngine.rebuild(s.node)));
                resultsByExpr = new Map();
                for (const m of FormulaUI.lastParsedResults.matches) {
                    const idx = parseInt(m.stepIndex, 10);
                    if (!Number.isNaN(idx) && indexToExpr.has(idx)) {
                        const expr = indexToExpr.get(idx);
                        resultsByExpr.set(expr, m.value);
                    }
                }
                // Populate the results Map so lookupResult/renderLabel see it
                results = resultsByExpr;
                resultsIsMapLike = true;
            } catch (_) { /* ignore */ }
        }

        const formatResult = (v) => {
            if (v === undefined) return undefined;
            if (v === null) return 'null';
            try {
                if (FormulaEngine && typeof FormulaEngine.isDate === 'function' && FormulaEngine.isDate(v)) {
                    return v.toISOString();
                }
            } catch (_) { /* ignore */ }
            if (typeof v === 'number' && v % 1 !== 0) return v.toFixed(6);
            return String(v);
        };
        const lookupResult = (node) => {
            if (!results) return undefined;
            const expr = FormulaEngine.rebuild(node);
            let v;
            if (resultsIsMapLike && typeof results.get === 'function') {
                v = results.get(node);
                if (v === undefined) v = results.get(expr);
            }
            if (v === undefined && resultsByExpr) {
                v = (typeof resultsByExpr.get === 'function') ? resultsByExpr.get(expr) : resultsByExpr[expr];
            }
            return v;
        };
        const esc = (s) => String(s)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\'')
            .replace(/\n/g, '\\n');

        const renderLabel = (node) => {
            switch (node.type) {
                case 'Function': {
                    const expr = FormulaEngine.rebuild(node);
                    const rv = formatResult(lookupResult(node));
                    return rv !== undefined ? `${expr} <br><br>= ${rv}` : `${expr}`;
                }
                case 'Operator': {
                    const expr = FormulaEngine.rebuild(node);
                    const rv = formatResult(lookupResult(node));
                    return rv !== undefined ? `${expr} <br><br>= ${rv}` : `${expr}`;
                }
                case 'Field':
                    return `${node.name}`;
                case 'Literal': {
                    let v = node.value;
                    if (v === null) v = 'null';
                    else if (v instanceof Date) v = v.toISOString();
                    else if (typeof v === 'string') v = `${v}`;
                    return `${v}`;
                }
                default:
                    return `Unknown`;
            }
        };

        const walk = (node) => {
            if (!node) return null;
            const id = newId();
            lines.push(`${id}["${esc(renderLabel(node))}"]`);
            if (node.type === 'Function') {
                for (const arg of node.arguments || []) {
                    if (arg && (arg.type === 'Function' || arg.type === 'Operator')) {
                        const cid = walk(arg);
                        if (cid) lines.push(`${id} --> ${cid}`);
                    }
                }
            } else if (node.type === 'Operator') {
                if (node.left && (node.left.type === 'Function' || node.left.type === 'Operator')) {
                    const l = walk(node.left);
                    if (l) lines.push(`${id} --> ${l}`);
                }
                if (node.right && (node.right.type === 'Function' || node.right.type === 'Operator')) {
                    const r = walk(node.right);
                    if (r) lines.push(`${id} --> ${r}`);
                }
            }
            return id;
        };

        if (ast) walk(ast);
        const mermaid = lines.join('\n');
        const output = fenced ? `\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n` : mermaid;
        try { console.log(output); } catch (_) { /* noop in tests */ }
        return mermaid;
    }

    // Reads formula text from the standard Salesforce editor textarea
    static extractFormulaContent(doc) {
        const formulaTextarea = doc.getElementById('CalculatedFormula');
        return formulaTextarea ? (formulaTextarea.value || 'No formula content found.') : 'Formula editor not found.';
    }

    // Renders variables, calculate button, and initial steps list into the debug area
    static displayDataStructure(ast, doc) {
        const debugOutput = doc.getElementById('debugOutput');
        if (!debugOutput) return;

        const variables = FormulaEngine.extractVariables(ast);
        const steps = FormulaEngine.extractCalculationSteps(ast);

        debugOutput.innerHTML = '';

        const container = doc.createElement('div');
        container.style.cssText = 'font-family: Arial, sans-serif;';

        if (variables.length > 0) {
            const varsDiv = doc.createElement('div');
            varsDiv.style.cssText = 'margin-bottom: 15px;';
            varsDiv.innerHTML = '<strong>Field Values</strong>';

            const varsList = doc.createElement('div');
            varsList.style.cssText = 'margin-top: 10px; display: grid; grid-template-columns: repeat(3, minmax(280px, 1fr)); gap: 8px 16px; align-items: start;';

            variables.forEach(variable => {
                const fieldDiv = doc.createElement('div');
                fieldDiv.style.cssText = 'display: flex; align-items: center;';

                const label = doc.createElement('span');
                label.textContent = `${variable}: `;
                label.style.cssText = 'display: inline-block; width: 120px; font-weight: bold;';

                const input = doc.createElement('input');
                input.id = `var-${variable}`;
                input.style.cssText = 'flex: 1; padding: 4px 8px; border: 1px solid #ccc; border-radius: 3px;';

                if (variable === 'NOW()') {
                    input.type = 'datetime-local';
                    input.placeholder = 'Select date/time for testing';
                    const now = new Date();
                    const localDateTime = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
                    input.value = localDateTime.toISOString().slice(0, 16);
                } else {
                    input.type = 'text';
                    input.placeholder = `Enter value for ${variable}`;
                }

                fieldDiv.appendChild(label);
                fieldDiv.appendChild(input);

                if (variable === 'NOW()') {
                    const helperText = doc.createElement('div');
                    helperText.style.cssText = 'font-size: 11px; color: #666; margin-top: 2px; margin-left: 120px;';
                    helperText.textContent = 'Leave empty to use current date/time';
                    fieldDiv.appendChild(helperText);
                }

                varsList.appendChild(fieldDiv);
            });

            varsDiv.appendChild(varsList);
            container.appendChild(varsDiv);

            const calculateBtn = doc.createElement('button');
            calculateBtn.textContent = 'Calculate Formula';
            calculateBtn.type = 'button';
            calculateBtn.style.cssText = 'padding: 8px 16px; background: #007cba; color: white; border: none; border-radius: 4px; cursor: pointer;';
            calculateBtn.addEventListener('click', async () => await this.calculateAndDisplay(ast, doc));
            container.appendChild(calculateBtn);

            const mermaidBtn = doc.createElement('button');
            mermaidBtn.textContent = 'Open Diagram';
            mermaidBtn.type = 'button';
            mermaidBtn.style.cssText = 'padding: 8px 16px; background: #555; color: white; border: none; border-radius: 4px; cursor: pointer; margin-left: 8px;';
            mermaidBtn.addEventListener('click', () => this.openMermaidDiagram(ast));
            container.appendChild(mermaidBtn);

            const apexToggleWrap = doc.createElement('label');
            apexToggleWrap.style.cssText = 'display:inline-flex; align-items:center; gap:6px; margin-left:10px; font-size: 12px;';
            const apexToggle = doc.createElement('input');
            apexToggle.type = 'checkbox';
            apexToggle.id = 'use-apex-steps';
            apexToggle.title = 'Calculate each step via Anonymous Apex';
            const apexToggleText = doc.createElement('span');
            apexToggleText.textContent = 'Use Anonymous Apex for steps calculation';
            apexToggleWrap.appendChild(apexToggle);
            apexToggleWrap.appendChild(apexToggleText);
            container.appendChild(apexToggleWrap);

            const resultDiv = doc.createElement('div');
            resultDiv.id = 'calculationResult';
            resultDiv.style.cssText = 'margin: 10px 0; padding: 10px; background: #e8f5e8; border: 1px solid #4caf50; border-radius: 4px; display: none;';
            container.appendChild(resultDiv);
        }

        if (steps.length > 0) {
            const stepsList = doc.createElement('div');
            stepsList.id = 'stepsList';
            stepsList.style.cssText = 'margin-top: 10px;';

            steps.forEach((step, index) => {
                const stepDiv = doc.createElement('div');
                stepDiv.style.cssText = 'margin: 5px 0; padding: 8px; background: #f9f9f9; border-left: 3px solid #007cba; font-family: monospace;';
                const t = (step.node && step.node.resultType) ? step.node.resultType : 'Unknown';
                stepDiv.textContent = `${index + 1}. ${step.expression}  ->  ${t}`;
                stepsList.appendChild(stepDiv);
            });

            container.appendChild(stepsList);
        }

        debugOutput.appendChild(container);
    }

    // Opens the Mermaid diagram in a new tab using mermaid.ink
    static openMermaidDiagram(ast) {
        if (!ast) return;
        try {
            const mermaid = FormulaUI.toMermaid(ast, { fenced: false });
            const toB64 = (str) => {
                // Encode UTF-8 safely before base64
                try { return btoa(unescape(encodeURIComponent(str))); }
                catch (_) { return btoa(str); }
            };
            const encoded = toB64(mermaid);
            const url = `https://mermaid.ink/svg/${encoded}`;
            if (typeof window !== 'undefined' && window.open) {
                const w = window.open(url, '_blank');
                if (!w) {
                    // Popup blocked; log URL as fallback
                    console.log('Mermaid diagram URL:', url);
                }
            } else {
                console.log('Mermaid diagram URL:', url);
            }
        } catch (e) {
            console.error('Unable to open Mermaid diagram:', e);
        }
    }

    // Calculates the overall formula result and updates per‑step results
    static async calculateAndDisplay(ast, doc) {
        const resultDiv = doc.getElementById('calculationResult');
        if (!resultDiv) return;

        try {
            const variables = this.getVariableValues(ast, doc);
            const useApex = !!(doc.getElementById('use-apex-steps') && doc.getElementById('use-apex-steps').checked);

            if (!useApex) {
                const result = FormulaEngine.calculate(ast, variables);
                const displayResult = result === null ? 'null' :
                                     FormulaEngine.isDate(result) ? result.toLocaleString() :
                                     typeof result === 'number' && result % 1 !== 0 ? result.toFixed(6) : result;
                resultDiv.innerHTML = `<strong>Result:</strong> ${displayResult}`;
                resultDiv.style.display = 'block';
                resultDiv.style.background = '#e8f5e8';
                resultDiv.style.borderColor = '#4caf50';
            } else {
                // Defer to Apex-driven mechanism in updateStepsWithCalculation
                resultDiv.innerHTML = `<strong>Result:</strong> Computing via Apex…`;
                resultDiv.style.display = 'block';
                resultDiv.style.background = '#fff8e1';
                resultDiv.style.borderColor = '#ffa000';
            }

            await this.updateStepsWithCalculation(ast, variables, doc);

        } catch (error) {
            resultDiv.innerHTML = `<strong>Error:</strong> ${error.message}`;
            resultDiv.style.display = 'block';
            resultDiv.style.background = '#ffe8e8';
            resultDiv.style.borderColor = '#f44336';
        }
    }

    // Rebuilds the steps list and fills in results (locally or via Apex)
    static async updateStepsWithCalculation(ast, variables, doc) {
        const stepsList = doc.getElementById('stepsList');
        if (!stepsList) return;

        try { FormulaEngine.annotateTypes(ast, variables); } catch(e) { /* ignore */ }

        const steps = FormulaEngine.extractCalculationSteps(ast);
        stepsList.innerHTML = '';
        const useApex = !!(doc.getElementById('use-apex-steps') && doc.getElementById('use-apex-steps').checked);
        let runId = null;
        if (useApex) {
            runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        }

        // Prepare to capture the last step value to reflect as main result
        const resultDiv = doc.getElementById('calculationResult');
        let lastResultComputed;

        for (const [index, step] of steps.entries()) {
            const stepDiv = doc.createElement('div');
            stepDiv.style.cssText = 'margin: 5px 0; padding: 8px; background: #f9f9f9; border-left: 3px solid #007cba;';

            const exprDiv = doc.createElement('div');
            exprDiv.style.cssText = 'font-family: monospace; font-weight: bold;';
            const t = (step.node && step.node.resultType) ? step.node.resultType : 'Unknown';
            exprDiv.textContent = `${index + 1}. ${step.expression}  ->  ${t}`;

            const resultSpan = doc.createElement('div');
            resultSpan.style.cssText = 'font-family: monospace; color: #007cba; margin-top: 4px;';
            if (!useApex) {
                let result;
                try {
                    result = FormulaEngine.calculate(step.node, variables);
                } catch (error) {
                    result = `Error: ${error.message}`;
                }
                const displayResult = result === null ? 'null' :
                                     FormulaEngine.isDate(result) ? result.toLocaleString() :
                                     typeof result === 'number' && result % 1 !== 0 ? result.toFixed(6) : result;
                resultSpan.textContent = `= ${displayResult}`;
                lastResultComputed = displayResult;
            } else {
                const idx = index + 1;
                resultSpan.id = `step-result-${runId}-${idx}`;
                resultSpan.textContent = '= …';
            }

            stepDiv.appendChild(exprDiv);
            stepDiv.appendChild(resultSpan);
            stepsList.appendChild(stepDiv);
        }

        if (useApex) {
            try {
                const anonymousApex = this.buildAnonymousApexForSteps(steps, ast, doc, runId);
                try {
                    const handler = new ToolingAPIHandler(host, sessionId, TOOLING_API_VERSION);
                    const ok = await handler.executeAnonymous(anonymousApex, runId, doc);
                    // expose last parsed results for other UI features (e.g., Mermaid)
                    if (handler && handler.lastParsedResults) {
                        FormulaUI.lastParsedResults = handler.lastParsedResults;
                        FormulaUI.lastRunId = handler.lastRunId;
                    }
                    // Use stored parsed results instead of reading DOM
                    if (ok && resultDiv && handler.lastParsedResults && Array.isArray(handler.lastParsedResults.matches)) {
                        const matches = handler.lastParsedResults.matches;
                        if (matches.length > 0) {
                            let last = matches[ matches.length - 1 ];
                            resultDiv.innerHTML = `<strong>Result:</strong> ${last.value}`;
                            resultDiv.style.display = 'block';
                            resultDiv.style.background = '#4caf50';
                            resultDiv.style.borderColor = '#4caf50';
                        }
                    }
                    return ok;
                } catch (err) {
                    console.error("ToolingAPIHandler error:", err);
                    return null;
                }
            } catch (e) {
                console.error('Failed to run batched Apex for steps:', e);
            }
        } else {
            // Local calculation path: reflect last step as main result
            if (resultDiv && lastResultComputed !== undefined) {
                resultDiv.innerHTML = `<strong>Result:</strong> ${lastResultComputed}`;
                resultDiv.style.display = 'block';
                resultDiv.style.background = '#4caf50';
                resultDiv.style.borderColor = '#4caf50';
            }
        }
    }

    // Build a single Anonymous Apex execution that evaluates all steps and logs results
    // Generates a single Anonymous Apex script that evaluates all steps and logs results
    static buildAnonymousApexForSteps(steps, astRoot, doc, runId) {
        const apexEscape = (s) => (s || '')
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r/g, '')
            .replace(/\n/g, '\\n');

        const inferSObjectFromUrl = () => {
            try {
                const href = window.location.href || '';
                const pathMatch = href.match(/ObjectManager\/([A-Za-z0-9_]+)\/Fields/i);
                if (pathMatch && pathMatch[1]) return pathMatch[1];
                const url = new URL(href);
                const params = url.searchParams;
                const candidates = ['type', 'ent', 'entity', 'entityname', 'sobject', 'sobjecttype'];
                for (const key of candidates) {
                    const v = params.get(key);
                    if (v && /^[A-Za-z0-9_]+$/.test(v)) return v;
                }
            } catch (_) { /* ignore */ }
            return 'Account';
        };

        const typeMap = {
            'Number': 'Decimal',
            'Boolean': 'Boolean',
            'Text': 'String',
            'Date': 'Date',
            'DateTime': 'DateTime'
        };

        const values = this.getVariableValues(astRoot, doc);
        const variables = FormulaEngine.extractVariables(astRoot);
        const idPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
        const escapeApexString = (str) => String(str)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r/g, '')
            .replace(/\n/g, '\\n');
        const toApexLiteral = (raw) => {
            if (raw === null || raw === undefined) return null;
            const s = String(raw).trim();
            if (s === '') return null;
            if (/^(true|false)$/i.test(s)) return s.toLowerCase();
            const n = Number(s);
            if (!isNaN(n) && isFinite(n)) return String(n);
            const isDateOnly = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s);
            const maybeDate = FormulaEngine.toDate(s);
            if (maybeDate) {
                const y = maybeDate.getUTCFullYear();
                const m = maybeDate.getUTCMonth() + 1;
                const d = maybeDate.getUTCDate();
                if (isDateOnly) {
                    return `Date.newInstance(${y}, ${m}, ${d})`;
                } else {
                    const hh = maybeDate.getUTCHours();
                    const mm = maybeDate.getUTCMinutes();
                    const ss = maybeDate.getUTCSeconds();
                    return `DateTime.newInstanceGMT(${y}, ${m}, ${d}, ${hh}, ${mm}, ${ss})`;
                }
            }
            return `'${escapeApexString(s)}'`;
        };

        const assignments = variables
            .filter(v => v !== 'NOW()' && idPattern.test(v))
            .map(v => ({ name: v, expr: toApexLiteral(values[v]) }))
            .filter(({ expr }) => expr !== null)
            .map(({ name, expr }) => `${name} = ${expr}`);

        const sobjectName = inferSObjectFromUrl();

        const lines = [];
        lines.push('FormulaEval.FormulaBuilder builder = Formula.builder();');
        lines.push('FormulaEval.FormulaInstance ff;');

        if (assignments.length > 0) {
            lines.push(`${sobjectName} obj = new ${sobjectName}(${assignments.join(', ')});`);
        } else {
            lines.push(`${sobjectName} obj = new ${sobjectName}();`);
        }

        for (let i = 0; i < steps.length; i++) {
            const node = steps[i].node;
            const expr = apexEscape(FormulaEngine.rebuild(node));
            const rt = typeMap[node.resultType] || 'Decimal';
            lines.push('ff = builder');
            lines.push(`    .withFormula('${expr}')`);
            lines.push(`    .withType(${sobjectName}.class)`);
            lines.push(`    .withReturnType(FormulaEval.FormulaReturnType.${rt})`);
            lines.push('    .build();');
            lines.push(`System.debug('SFDBG|${runId}|${i+1}|' + String.valueOf(ff.evaluate(obj)));`);
        }

        return lines.join('\n');
    }

    // Reads user‑entered variable values from the rendered inputs
    static getVariableValues(ast, doc) {
        const variables = FormulaEngine.extractVariables(ast);
        const values = {};
        variables.forEach(variable => {
            const input = doc.getElementById(`var-${variable}`);
            values[variable] = input ? (input.value || "") : "";
        });
        return values;
    }
}

// Initialize content script when iframe is loaded (guarded for Node tests)
if (typeof window !== 'undefined') {
    const uiBootstrap = new UIBootstrap();
    uiBootstrap.init();
}

// Export for Node.js tests (without affecting browser usage)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Tokenizer, Parser, ToolingAPIHandler, FormulaEngine, FormulaUI };
}
