const GETHOSTANDSESSION = "getHostSession";
const TOOLING_API_VERSION = 'v57.0';

function urlMatchesFormulaEditor() {
    return window.location.href.includes('/e?');
}

// Initialize content script when iframe is loaded (guarded for Node tests)
if (typeof window !== 'undefined' && urlMatchesFormulaEditor()) {

    // Check if we're in the main frame or iframe
    if (window === window.top) {
        // Main frame - wait for iframe and element
        waitForIframeAndElement();
    } else {
        // We're in an iframe - check for the element directly
        waitForElement('CalculatedFormula', createFormulaButton);
    }
}

// (module.exports assigned at end of file after class declarations)

function waitForElement(elementId, callback) {
    const element = document.getElementById(elementId);
    if (element) {
        callback();
        return;
    }

    const observer = new MutationObserver((mutations, obs) => {
        const element = document.getElementById(elementId);
        if (element) {
            obs.disconnect();
            callback();
        }
    });

    observer.observe(document, {
        childList: true,
        subtree: true
    });
}

function waitForIframeAndElement() {
    const checkForElement = () => {
        // Check in main document first
        let element = document.getElementById('CalculatedFormula');
        if (element) {
            createFormulaButton();
            return;
        }
        
        // // Check in iframes
        // const iframes = document.getElementsByTagName('iframe');
        // for (let iframe of iframes) {
        //     if( iframe.src === '' || iframe.src.includes('chrome-extension:') ) {
        //         continue;
        //     }
        //     try {
        //         const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        //         element = iframeDoc.getElementById('CalculatedFormula');
        //         if (element) {
        //             injectDebuggerUI(iframeDoc);
        //             return;
        //         }
        //     } catch (e) {
        //         // Cross-origin iframe - can't access
        //         console.log('Cannot access iframe:', e);
        //     }
        // }
        
        // Retry if not found
        setTimeout(checkForElement, 500);
    };
    
    checkForElement();
}

var host, sessionId;
function storeHostAndSessionId() {
    // get host and session from background script
    let getHostMessage = { message: GETHOSTANDSESSION
        , url: location.href 
    };
    chrome.runtime.sendMessage( getHostMessage, resultData => {
        host = resultData.domain;
        sessionId = resultData.session;
    } );
}

function createFormulaButton() {
    let doc = window.document;
    let formulaTextarea = doc.getElementById('CalculatedFormula');
    if (!formulaTextarea) {
        console.log('Could not find formula textarea after multiple attempts.');
        return;
    }
    
    if (doc.getElementById('formulaDebugger')) {
        console.log('Formula Debugger already set up.');
        return;
    }

    let debuggerDiv = doc.createElement('div');
    debuggerDiv.id = 'formulaDebugger';
    debuggerDiv.style.cssText = 'margin-top: 10px; padding: 10px; border: 1px solid #ccc; background: #f9f9f9; font-family: Arial, sans-serif;';
    debuggerDiv.innerHTML = `
        <button id="runDebug" type="button" style="padding: 5px 10px;">Run Formula Debugger</button>
        <div id="debugOutput">Debug output will appear here once implemented.</div>
    `;
    formulaTextarea.parentNode.insertBefore(debuggerDiv, formulaTextarea.nextSibling);

    // Add event listener for debug button
    doc.getElementById('runDebug').addEventListener('click', runDebug);
}

function runDebug() {
    storeHostAndSessionId();
    let doc = window.document;
    let formula = extractFormulaContent(doc);
    let debugOutput = doc.getElementById('debugOutput');
    if(!debugOutput) {
        console.error('Debug output element not found.');
        return;
    }

    try {
        if (!formula || formula.trim() === '') {
            debugOutput.innerText = 'No formula to analyze';
            return;
        }

        const parser = new Parser();
        const ast = parser.parse(formula.trim());
        // annotate AST with inferred result types
        annotateTypes(ast);
        
        displayDataStructure(ast, doc);
        
    } catch (error) {
        debugOutput.innerHTML = `<div style="color: red; padding: 10px; background: #ffe8e8; border: 1px solid #f44336; border-radius: 4px;">
            <strong>Formula Analysis Error:</strong><br>${error.message}
        </div>`;
    }
}

function extractFormulaContent(doc) {
    let formulaTextarea = doc.getElementById('CalculatedFormula');
    return formulaTextarea ? formulaTextarea.value || 'No formula content found.' : 'Formula editor not found.';
}

const TOKEN_PATTERNS = [
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

class Tokenizer {
    initialize(inputString) {
        this._expression = inputString;
        this._currentPos = 0;
        this._parenStack = [];
    }

    hasMoreTokens() {
        return this._currentPos < this._expression.length;
    }

    getNextToken() {
        if (!this.hasMoreTokens()) {
            return null;
        }

        const remainingPart = this._expression.slice(this._currentPos);

        for (const [regExpression, tokenType] of TOKEN_PATTERNS) {
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

    findMatch(regExpression, remainingPart) {
        const theMatch = remainingPart.match(regExpression);
        if (!theMatch) {
            return null;
        }
        return theMatch[0];
    }

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
    constructor() {
        this._string = '';
        this._tokenizer = new Tokenizer();
        this._tokens = [];
        this._currentIndex = 0;
    }

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

    peek() {
        return this._currentIndex < this._tokens.length ? this._tokens[this._currentIndex] : null;
    }

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

    parseExpression() {
        let node = this.parseEquality();
        while (this.peek() && (this.peek().token === '&&' || this.peek().token === '||')) {
            const operator = this.consume().token;
            const right = this.parseEquality();
            node = { type: 'Operator', operator, left: node, right };
        }
        return node;
    }

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

    parseTerm() {
        let node = this.parseFactor();
        while (this.peek() && (this.peek().token === '+' || this.peek().token === '-')) {
            const operator = this.consume().token;
            const right = this.parseFactor();
            node = { type: 'Operator', operator, left: node, right };
        }
        return node;
    }

    parseFactor() {
        let node = this.parsePrimary();
        while (this.peek() && (this.peek().token === '*' || this.peek().token === '/')) {
            const operator = this.consume().token;
            const right = this.parsePrimary();
            node = { type: 'Operator', operator, left: node, right };
        }
        return node;
    }

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

function extractVariables(ast) {
    const variables = new Set();

    function traverse(node) {
        if (!node) return;

        switch (node.type) {
            case "Field":
                variables.add(node.name);
                break;
            case "Function":
                // Special handling for NOW() - treat it as a testable variable
                if (node.name.toUpperCase() === "NOW") {
                    variables.add("NOW()");
                }
                node.arguments.forEach(arg => traverse(arg));
                break;
            case "Operator":
                traverse(node.left);
                traverse(node.right);
                break;
            case "Literal":
                break;
            default:
                throw new Error(`Unknown AST node type: ${node.type}`);
        }
    }

    traverse(ast);
    return Array.from(variables);
}

// Simple result type system to annotate AST nodes
const RESULT_TYPE = {
    Text: 'Text',
    Number: 'Number',
    Boolean: 'Boolean',
    Date: 'Date',
    DateTime: 'DateTime',
    Unknown: 'Unknown'
};

function inferLiteralResultType(value) {
    if (value === null || value === undefined) return RESULT_TYPE.Unknown;
    if (typeof value === 'number') return RESULT_TYPE.Number;
    if (typeof value === 'string') return RESULT_TYPE.Text;
    if (isDate(value)) return RESULT_TYPE.DateTime; // JS Date holds date-time
    return RESULT_TYPE.Unknown;
}

function unifyTypes(a, b) {
    if (!a) return b || RESULT_TYPE.Unknown;
    if (!b) return a || RESULT_TYPE.Unknown;
    if (a === b) return a;
    // If any is Text, treat as Text
    if (a === RESULT_TYPE.Text || b === RESULT_TYPE.Text) return RESULT_TYPE.Text;
    // Date + Number yields Date; DateTime + Number yields DateTime
    if ((a === RESULT_TYPE.Date && b === RESULT_TYPE.Number) || (b === RESULT_TYPE.Date && a === RESULT_TYPE.Number)) return RESULT_TYPE.Date;
    if ((a === RESULT_TYPE.DateTime && b === RESULT_TYPE.Number) || (b === RESULT_TYPE.DateTime && a === RESULT_TYPE.Number)) return RESULT_TYPE.DateTime;
    // Prefer Number over Unknown
    if (a === RESULT_TYPE.Unknown) return b;
    if (b === RESULT_TYPE.Unknown) return a;
    // Fallback to Unknown when incompatible
    return RESULT_TYPE.Unknown;
}

function functionReturnType(name, argTypes) {
    const n = name.toUpperCase();
    switch (n) {
        case 'IF':
            // IF(condition:Boolean, then:X, else:X) => X (unify then/else)
            return unifyTypes(argTypes[1], argTypes[2]);
        case 'CONTAINS':
            return RESULT_TYPE.Boolean;
        case 'FIND':
            return RESULT_TYPE.Number;
        case 'MID':
            return RESULT_TYPE.Text;
        case 'FLOOR':
            return RESULT_TYPE.Number;
        case 'CASE':
            // CASE(expression, val1,res1, ..., default) => unify of results
            if (argTypes.length >= 3) {
                let t = RESULT_TYPE.Unknown;
                for (let i = 2; i < argTypes.length; i += 2) {
                    t = unifyTypes(t, argTypes[i]);
                }
                // default at the end if odd count after expression
                if ((argTypes.length - 1) % 2 === 1) {
                    t = unifyTypes(t, argTypes[argTypes.length - 1]);
                }
                return t;
            }
            return RESULT_TYPE.Unknown;
        case 'AND':
        case 'OR':
        case 'NOT':
        case 'ISPICKVAL':
        case 'ISBLANK':
            return RESULT_TYPE.Boolean;
        case 'NOW':
            return RESULT_TYPE.DateTime;
        case 'DATE':
            return RESULT_TYPE.Date;
        case 'DATEVALUE':
            return RESULT_TYPE.Date;
        default:
            return RESULT_TYPE.Unknown;
    }
}

// Annotate AST nodes with resultType by static inference and sample inputs
function annotateTypes(ast, sampleVariables = {}) {
    function infer(node) {
        if (!node) return RESULT_TYPE.Unknown;
        switch (node.type) {
            case 'Literal': {
                node.resultType = inferLiteralResultType(node.value);
                return node.resultType;
            }
            case 'Field': {
                // Try to infer from provided sample value
                const v = sampleVariables[node.name];
                if (v === undefined || v === null || v === '') {
                    node.resultType = RESULT_TYPE.Unknown;
                } else if (typeof v === 'number') {
                    node.resultType = RESULT_TYPE.Number;
                } else if (isDate(v)) {
                    node.resultType = RESULT_TYPE.DateTime;
                } else if (typeof v === 'string') {
                    // Try to parse date/datetime, else number, else text
                    const dt = toDate(v);
                    if (dt) {
                        // Heuristic: if string includes 'T' assume DateTime; else Date
                        node.resultType = v.includes('T') ? RESULT_TYPE.DateTime : RESULT_TYPE.Date;
                    } else if (!isNaN(parseFloat(v))) {
                        node.resultType = RESULT_TYPE.Number;
                    } else {
                        node.resultType = RESULT_TYPE.Text;
                    }
                } else {
                    node.resultType = RESULT_TYPE.Unknown;
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
                        node.resultType = RESULT_TYPE.Boolean;
                        break;
                    case '+': {
                        if (lt === RESULT_TYPE.Text || rt === RESULT_TYPE.Text) node.resultType = RESULT_TYPE.Text;
                        else if (lt === RESULT_TYPE.Date && rt === RESULT_TYPE.Number) node.resultType = RESULT_TYPE.Date;
                        else if (lt === RESULT_TYPE.Number && rt === RESULT_TYPE.Date) node.resultType = RESULT_TYPE.Date;
                        else if (lt === RESULT_TYPE.DateTime && rt === RESULT_TYPE.Number) node.resultType = RESULT_TYPE.DateTime;
                        else if (lt === RESULT_TYPE.Number && rt === RESULT_TYPE.DateTime) node.resultType = RESULT_TYPE.DateTime;
                        else node.resultType = RESULT_TYPE.Number;
                        break;
                    }
                    case '-': {
                        if ((lt === RESULT_TYPE.Date || lt === RESULT_TYPE.DateTime) && (rt === RESULT_TYPE.Date || rt === RESULT_TYPE.DateTime)) {
                            node.resultType = RESULT_TYPE.Number; // difference in days
                        } else if ((lt === RESULT_TYPE.Date || lt === RESULT_TYPE.DateTime) && rt === RESULT_TYPE.Number) {
                            node.resultType = lt; // same date-like type
                        } else {
                            node.resultType = RESULT_TYPE.Number;
                        }
                        break;
                    }
                    case '*':
                    case '/':
                        node.resultType = RESULT_TYPE.Number;
                        break;
                    default:
                        node.resultType = RESULT_TYPE.Unknown;
                }
                return node.resultType;
            }
            case 'Function': {
                const argTypes = node.arguments.map(arg => infer(arg));
                node.resultType = functionReturnType(node.name, argTypes);
                return node.resultType;
            }
            default:
                node.resultType = RESULT_TYPE.Unknown;
                return node.resultType;
        }
    }

    infer(ast);
    return ast;
}

function rebuildFormula(ast) {
    if (!ast || !ast.type) return "";

    switch (ast.type) {
        case "Function":
            const args = ast.arguments.map(arg => rebuildFormula(arg)).join(", ");
            return `${ast.name}(${args})`;
        case "Operator":
            const left = rebuildFormula(ast.left);
            const right = rebuildFormula(ast.right);
            return `${left} ${ast.operator} ${right}`;
        case "Field":
            return ast.name;
        case "Literal":
            if (ast.value === null) {
                return "null";
            }
            if (typeof ast.value === "string") {
                return `"${ast.value}"`;
            }
            return ast.value.toString();
        default:
            throw new Error(`Unknown AST node type: ${ast.type}`);
    }
}

function extractCalculationSteps(ast) {
    const steps = [];
    const seen = new Set();

    function traverse(node) {
        if (!node) return;

        switch (node.type) {
            case "Function":
                node.arguments.forEach(arg => traverse(arg));
                const expr = rebuildFormula(node);
                if (!seen.has(expr)) {
                    seen.add(expr);
                    steps.push({ expression: expr, node });
                }
                break;
            case "Operator":
                traverse(node.left);
                traverse(node.right);
                const opExpr = rebuildFormula(node);
                if (!seen.has(opExpr)) {
                    seen.add(opExpr);
                    steps.push({ expression: opExpr, node });
                }
                break;
            case "Field":
            case "Literal":
                break;
            default:
                throw new Error(`Unknown AST node type: ${node.type}`);
        }
    }

    traverse(ast);
    return steps;
}

function isDate(value) {
    return value instanceof Date;
}

function isDateString(value) {
    if (typeof value !== 'string' || value.trim() === '') return false;
    const date = new Date(value);
    return !isNaN(date.getTime());
}

function toDate(value) {
    if (isDate(value)) return value;
    if (isDateString(value)) return new Date(value);
    return null;
}

function toNumber(value) {
    if (typeof value === 'number') return value;
    if (isDate(value)) return value.getTime();
    const num = parseFloat(value);
    return isNaN(num) ? 0 : num;
}

function calculateFormula(ast, variables = {}) {
    if (!ast) return null;

    switch (ast.type) {
        case "Function":
            const args = ast.arguments.map(arg => calculateFormula(arg, variables));
            switch (ast.name.toUpperCase()) {
                case "IF": return args[0] ? args[1] : args[2];
                case "CONTAINS":
                    const text = String(args[0] || "");
                    const substring = String(args[1] || "");
                    return text.includes(substring);
                case "FIND":
                    const findText = String(args[1] || "");
                    const findSubstring = String(args[0] || "");
                    const startPos = args[2] ? parseInt(args[2]) - 1 : 0;
                    const pos = findText.indexOf(findSubstring, startPos);
                    return pos === -1 ? 0 : pos + 1;
                case "MID":
                    const midText = String(args[0] || "");
                    const start = parseInt(args[1] || 1) - 1;
                    const length = parseInt(args[2] || 0);
                    return midText.substr(start, length);
                case "FLOOR":
                    if (args.length !== 1) 
                        throw new Error("FLOOR requires exactly one argument");
                    const number = parseFloat(args[0]);
                    if (isNaN(number)) 
                        throw new Error("FLOOR argument must be numeric");
                    return Math.floor(number);
                case "CASE":
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
                case "AND":
                    if (args.length === 0) {
                        throw new Error("AND requires at least one argument");
                    }
                    return args.every(arg => Boolean(arg));
                case "OR":
                    if (args.length === 0) {
                        throw new Error("OR requires at least one argument");
                    }
                    return args.some(arg => Boolean(arg));
                case "NOT":
                    if (args.length !== 1) {
                        throw new Error("NOT requires exactly one argument");
                    }
                    return !Boolean(args[0]);
                case "ISPICKVAL":
                    if (args.length !== 2) {
                        throw new Error("ISPICKVAL requires exactly two arguments: field and value");
                    }
                    const fieldValue = String(args[0] || "");
                    const picklistValue = String(args[1] || "");
                    return fieldValue === picklistValue;
                case "ISBLANK":
                    if (args.length !== 1) {
                        throw new Error("ISBLANK requires exactly one argument");
                    }
                    const value = args[0];
                    if (value === null || value === undefined) {
                        return true;
                    }
                    const stringValue = String(value).trim();
                    return stringValue === "";
                case "NOW":
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
                case "DATEVALUE":
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
                case "DATE":
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
                default: throw new Error(`Unsupported function: ${ast.name}`);
            }

        case "Operator":
            const left = calculateFormula(ast.left, variables);
            const right = calculateFormula(ast.right, variables);
            
            const leftDate = toDate(left);
            const rightDate = toDate(right);
            
            switch (ast.operator) {
                case "+":
                    // String concatenation
                    if (typeof left === "string" || typeof right === "string") {
                        return String(left) + String(right);
                    }
                    // Date + number (add days)
                    if (leftDate && typeof right === "number") {
                        return new Date(leftDate.getTime() + (right * 24 * 60 * 60 * 1000));
                    }
                    if (typeof left === "number" && rightDate) {
                        return new Date(rightDate.getTime() + (left * 24 * 60 * 60 * 1000));
                    }
                    // Number arithmetic
                    return (parseFloat(left) || 0) + (parseFloat(right) || 0);
                
                case "-":
                    // Date - Date = difference in days
                    if (leftDate && rightDate) {
                        const diffMs = leftDate.getTime() - rightDate.getTime();
                        return diffMs / (1000 * 60 * 60 * 24); // Convert to days
                    }
                    // Date - number (subtract days)
                    if (leftDate && typeof right === "number") {
                        return new Date(leftDate.getTime() - (right * 24 * 60 * 60 * 1000));
                    }
                    // Number arithmetic
                    return (parseFloat(left) || 0) - (parseFloat(right) || 0);
                
                case "*": return (parseFloat(left) || 0) * (parseFloat(right) || 0);
                case "/":
                    const divisor = parseFloat(right) || 0;
                    if (divisor === 0) throw new Error("Division by zero");
                    return (parseFloat(left) || 0) / divisor;
                case "&&": return Boolean(left) && Boolean(right);
                case "||": return Boolean(left) || Boolean(right);
                case "=": 
                    // Date comparison
                    if (leftDate && rightDate) {
                        return leftDate.getTime() === rightDate.getTime();
                    }
                    return left === right;
                case "<>": 
                case "!=": 
                    // Date comparison
                    if (leftDate && rightDate) {
                        return leftDate.getTime() !== rightDate.getTime();
                    }
                    return left !== right;
                case "<": 
                    // Date comparison
                    if (leftDate && rightDate) {
                        return leftDate.getTime() < rightDate.getTime();
                    }
                    return (parseFloat(left) || 0) < (parseFloat(right) || 0);
                case ">": 
                    // Date comparison
                    if (leftDate && rightDate) {
                        return leftDate.getTime() > rightDate.getTime();
                    }
                    return (parseFloat(left) || 0) > (parseFloat(right) || 0);
                case "<=": 
                    // Date comparison
                    if (leftDate && rightDate) {
                        return leftDate.getTime() <= rightDate.getTime();
                    }
                    return (parseFloat(left) || 0) <= (parseFloat(right) || 0);
                case ">=": 
                    // Date comparison
                    if (leftDate && rightDate) {
                        return leftDate.getTime() >= rightDate.getTime();
                    }
                    return (parseFloat(left) || 0) >= (parseFloat(right) || 0);
                default: throw new Error(`Unsupported operator: ${ast.operator}`);
            }

        case "Field":
            const fieldValue = variables[ast.name] !== undefined ? variables[ast.name] : "";
            // Try to parse as date if it looks like a date string
            if (typeof fieldValue === 'string' && fieldValue.trim() !== '') {
                const dateValue = toDate(fieldValue);
                if (dateValue) return dateValue;
            }
            return fieldValue;

        case "Literal":
            return ast.value;

        default:
            throw new Error(`Unknown AST node type: ${ast.type}`);
    }
}

function getVariableValues(ast, doc) {
    const variables = extractVariables(ast);
    const values = {};
    variables.forEach(variable => {
        const input = doc.getElementById(`var-${variable}`);
        values[variable] = input ? (input.value || "") : "";
    });
    return values;
}

function displayDataStructure(ast, doc) {
    const debugOutput = doc.getElementById('debugOutput');
    if (!debugOutput) return;

    const variables = extractVariables(ast);
    const steps = extractCalculationSteps(ast);
    
    debugOutput.innerHTML = '';
    
    const container = doc.createElement('div');
    container.style.cssText = 'font-family: Arial, sans-serif;';
    
    if (variables.length > 0) {
        const varsDiv = doc.createElement('div');
        varsDiv.style.cssText = 'margin-bottom: 15px;';
        varsDiv.innerHTML = '<strong>Field Values</strong>';
        
        const varsList = doc.createElement('div');
        varsList.style.cssText = 'margin-top: 10px;';
        
        variables.forEach(variable => {
            const fieldDiv = doc.createElement('div');
            fieldDiv.style.cssText = 'margin: 5px 0; display: flex; align-items: center;';
            
            const label = doc.createElement('span');
            label.textContent = `${variable}: `;
            label.style.cssText = 'display: inline-block; width: 120px; font-weight: bold;';
            
            const input = doc.createElement('input');
            input.id = `var-${variable}`;
            input.style.cssText = 'flex: 1; padding: 4px 8px; border: 1px solid #ccc; border-radius: 3px;';
            
            // Special handling for NOW() function
            if (variable === 'NOW()') {
                input.type = 'datetime-local';
                input.placeholder = 'Select date/time for testing';
                // Set default to current date/time in local datetime format
                const now = new Date();
                const localDateTime = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
                input.value = localDateTime.toISOString().slice(0, 16);
            } else {
                input.type = 'text';
                input.placeholder = `Enter value for ${variable}`;
            }
            
            fieldDiv.appendChild(label);
            fieldDiv.appendChild(input);
            
            // Add helper text for NOW() after the input
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
        calculateBtn.style.cssText = 'padding: 8px 16px; background: #007cba; color: white; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 15px;';
        calculateBtn.addEventListener('click', async () => await calculateAndDisplay(ast, doc));
        container.appendChild(calculateBtn);

        // Switch to control per-step calculation engine
        const apexToggleWrap = doc.createElement('label');
        apexToggleWrap.style.cssText = 'display:inline-flex; align-items:center; gap:6px; margin-left:10px; font-size: 12px;';
        const apexToggle = doc.createElement('input');
        apexToggle.type = 'checkbox';
        apexToggle.id = 'use-apex-steps';
        apexToggle.title = 'Calculate each step via Anonymous Apex';
        const apexToggleText = doc.createElement('span');
        apexToggleText.textContent = 'Use Anonymous Apex for steps';
        apexToggleWrap.appendChild(apexToggle);
        apexToggleWrap.appendChild(apexToggleText);
        container.appendChild(apexToggleWrap);
        
        const resultDiv = doc.createElement('div');
        resultDiv.id = 'calculationResult';
        resultDiv.style.cssText = 'margin: 10px 0; padding: 10px; background: #e8f5e8; border: 1px solid #4caf50; border-radius: 4px; display: none;';
        container.appendChild(resultDiv);
    }
    
    if (steps.length > 0) {
        const stepsDiv = doc.createElement('div');
        stepsDiv.innerHTML = `<strong>Calculation Steps (${steps.length}):</strong>`;
        stepsDiv.style.cssText = 'margin-bottom: 10px;';
        
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
        
        stepsDiv.appendChild(stepsList);
        container.appendChild(stepsDiv);
    }
    
    debugOutput.appendChild(container);
}

// Build a single Anonymous Apex execution that evaluates all steps and logs results
function buildAnonymousApexForSteps(steps, astRoot, doc, runId) {
    // Builds Anonymous Apex script that evaluates each formula
    // FormulaEval.FormulaBuilder builder = Formula.builder(); 
    // FormulaEval.FormulaInstance ff = builder
    //     .withFormula('1+2')
    //     .withType(Account.class)
    //     .withReturnType(FormulaEval.FormulaReturnType.Decimal)
    //     .build();
    // System.debug( ff.evaluate(new Account()) );
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

    // Build field assignments from the current inputs
    const values = getVariableValues(astRoot, doc);
    const variables = extractVariables(astRoot);
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
        const maybeDate = toDate(s);
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
        const expr = apexEscape(rebuildFormula(node));
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

async function calculateAndDisplay(ast, doc) {
    const resultDiv = doc.getElementById('calculationResult');
    if (!resultDiv) return;
    
    try {
        const variables = getVariableValues(ast, doc);
        const result = calculateFormula(ast, variables);
        
        const displayResult = result === null ? 'null' : 
                             isDate(result) ? result.toLocaleString() : 
                             typeof result === 'number' && result % 1 !== 0 ? result.toFixed(6) : result;
        resultDiv.innerHTML = `<strong>Result:</strong> ${displayResult}`;
        resultDiv.style.display = 'block';
        resultDiv.style.background = '#e8f5e8';
        resultDiv.style.borderColor = '#4caf50';
        
        await updateStepsWithCalculation(ast, variables, doc);
        
    } catch (error) {
        resultDiv.innerHTML = `<strong>Error:</strong> ${error.message}`;
        resultDiv.style.display = 'block';
        resultDiv.style.background = '#ffe8e8';
        resultDiv.style.borderColor = '#f44336';
    }
}

async function updateStepsWithCalculation(ast, variables, doc) {
    const stepsList = doc.getElementById('stepsList');
    if (!stepsList) return;
    
    // Re-annotate with types using provided sample values
    try { annotateTypes(ast, variables); } catch(e) { /* ignore */ }

    const steps = extractCalculationSteps(ast);
    stepsList.innerHTML = '';
    const useApex = !!(doc.getElementById('use-apex-steps') && doc.getElementById('use-apex-steps').checked);
    // Correlate one log to this rendering round
    let runId = null;
    if (useApex) {
        runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    
    // forEach async does not preserve order, so use for..of
    //steps.forEach( async (step, index) => {
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
                result = calculateFormula(step.node, variables);
            } catch (error) {
                result = `Error: ${error.message}`;
            }
            const displayResult = result === null ? 'null' : 
                                 isDate(result) ? result.toLocaleString() : 
                                 typeof result === 'number' && result % 1 !== 0 ? result.toFixed(6) : result;
            resultSpan.textContent = `= ${displayResult}`;
        } else {
            // Placeholder; results filled when log returns
            const idx = index + 1;
            resultSpan.id = `step-result-${runId}-${idx}`;
            resultSpan.textContent = '= …';
        }
        
        stepDiv.appendChild(exprDiv);
        stepDiv.appendChild(resultSpan);
        stepsList.appendChild(stepDiv);
    }

    // Submit a single Anonymous Apex with all steps
    if (useApex) {
        try {
            const apex = buildAnonymousApexForSteps(steps, ast, doc, runId);
            await calculateFormulaViaAnonymousApex(apex, runId, doc);
        } catch (e) {
            console.error('Failed to run batched Apex for steps:', e);
        }
    }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function calculateFormulaViaAnonymousApex( anonymousApex, runId = null, doc = null ) {
    // Delegate to ToolingAPIHandler using the current host/sessionId
    try {
        const handler = new ToolingAPIHandler(host, sessionId, TOOLING_API_VERSION);
        return await handler.executeAnonymous(anonymousApex, runId, doc);
    } catch (err) {
        console.error("ToolingAPIHandler error:", err);
        return null;
    }
}

async function retrieveDebugLogId( hostArg, sessionIdArg, runId = null, doc = null ) {
    try {
        const handler = new ToolingAPIHandler(hostArg, sessionIdArg, TOOLING_API_VERSION);
        return await handler.retrieveDebugLogId(runId, doc);
    } catch (err) {
        console.error("ToolingAPIHandler error:", err);
        return null;
    }
}

async function retrieveDebugLogBody( hostArg, sessionIdArg, apexLogId, runId = null, doc = null ) {
    try {
        const handler = new ToolingAPIHandler(hostArg, sessionIdArg, TOOLING_API_VERSION);
        return await handler.retrieveDebugLogBody(apexLogId, runId, doc);
    } catch (err) {
        console.error("ToolingAPIHandler error:", err);
        return null;
    }
}

// Display parsed SFDBG results into the provided document
function displayParsedResults(parsed, doc) {
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

class ToolingAPIHandler {
    constructor(host, sessionId, apiVersion = TOOLING_API_VERSION) {
        this.host = host;
        this.sessionId = sessionId;
        this.apiVersion = apiVersion;
    }

    encodeAnonymous(anonymousApex) {
        return encodeURI(anonymousApex)
            .replaceAll('(', '%28')
            .replaceAll(')', '%29')
            .replaceAll(';', '%3B')
            .replaceAll('+', '%2B');
    }

    async executeAnonymous(anonymousApex, runId = null, doc = null) {
        // Ensure there is an active TraceFlag for the current user
        try {
            await this.ensureActiveTraceFlag();
        } catch (e) {
            console.warn('Could not ensure TraceFlag:', e);
        }
        const endpoint = `https://${this.host}/services/data/${this.apiVersion}/tooling/executeAnonymous/?anonymousBody=${this.encodeAnonymous(anonymousApex)}`;
        const request = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.sessionId}`
            }
        };

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

            await sleep(750);
            return this.retrieveDebugLogId(runId, doc);
        } catch (err) {
            console.error('Network or parsing error:', err);
        }
        return null;
    }

    async ensureActiveTraceFlag() {
        const userId = await this.getCurrentUserId();
        if (!userId) return false;

        // Check for existing active TraceFlag
        const now = new Date();
        const q = encodeURIComponent(`SELECT Id, StartDate, ExpirationDate, DebugLevelId FROM TraceFlag WHERE TracedEntityId='${userId}' ORDER BY ExpirationDate DESC`);
        const tfEndpoint = `https://${this.host}/services/data/${this.apiVersion}/tooling/query/?q=${q}`;
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.sessionId}` };
        try {
            const resp = await fetch(tfEndpoint, { method: 'GET', headers });
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
        const createEndpoint = `https://${this.host}/services/data/${this.apiVersion}/tooling/sobjects/TraceFlag`;
        try {
            const createResp = await fetch(createEndpoint, { method: 'POST', headers, body: JSON.stringify(body) });
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

    async ensureDebugLevel() {
        const name = 'SFFormulaDebug';
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.sessionId}` };
        const q = encodeURIComponent(`SELECT Id FROM DebugLevel WHERE DeveloperName='${name}'`);
        const dlEndpoint = `https://${this.host}/services/data/${this.apiVersion}/tooling/query/?q=${q}`;
        try {
            const resp = await fetch(dlEndpoint, { method: 'GET', headers });
            const data = await resp.json();
            if (data && data.records && data.records.length) {
                return data.records[0].Id;
            }
        } catch (e) {
            console.warn('DebugLevel query failed', e);
        }

        // Create DebugLevel
        const createEndpoint = `https://${this.host}/services/data/${this.apiVersion}/tooling/sobjects/DebugLevel`;
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
            const resp = await fetch(createEndpoint, { method: 'POST', headers, body: JSON.stringify(body) });
            const data = await resp.json();
            if (data && data.id) return data.id;
        } catch (e) {
            console.warn('DebugLevel create failed', e);
        }
        return null;
    }

    async getCurrentUserId() {
        const endpoint = `https://${this.host}/services/data/${this.apiVersion}/chatter/users/me`;
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.sessionId}` };
        try {
            const resp = await fetch(endpoint, { method: 'GET', headers });
            const data = await resp.json();
            // Chatter users/me includes id
            if (data && data.id) return data.id;
        } catch (e) {
            console.warn('Could not get current user id', e);
        }
        return null;
    }

    async retrieveDebugLogId(runId = null, doc = null) {
        const endpoint = `https://${this.host}/services/data/${this.apiVersion}/tooling/query/?q=SELECT Id FROM ApexLog WHERE LogLength > 10000 ORDER BY StartTime DESC LIMIT 1`;
        const request = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.sessionId}`
            }
        };

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

    async retrieveDebugLogBody(apexLogId, runId = null, doc = null) {
        const endpoint = `https://${this.host}/services/data/${this.apiVersion}/tooling/sobjects/ApexLog/${apexLogId}/Body`;
        const request = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.sessionId}`
            }
        };

        try {
            const response = await fetch(endpoint, request);
            const apexLog = await response.text();
            const parsed = this.parseApexLog(apexLog, runId);
            const displayed = displayParsedResults(parsed, doc);
            if (displayed) return true;
            return parsed.fallback;
        } catch (err) {
            console.error('Network or parsing error:', err);
        }
        return null;
    }

    // Parse Apex log and extract SFDBG results and fallback message
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
}


// Export for Node.js tests (without affecting browser usage)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Tokenizer, Parser, ToolingAPIHandler };
}
