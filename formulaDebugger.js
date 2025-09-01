
const WHITESPACE = 'WHITESPACE';
const SINGLE_LINE_COMMENT = 'SINGLE_LINE_COMMENT';
const MULTI_LINE_COMMENT = 'MULTI_LINE_COMMENT';
const TOKEN_PATTERNS = [
    [ /^\s+/, 'WHITESPACE' ],
    [ /^"[^"]*"/, 'DOUBLE_QUOTE_STRING' ],
    [ /^\d+/, 'NUMBER' ],
    [ /^'[^']*'/, 'STRING' ],
    //[ /^{\![a-zA-Z_]\w*}/, 'VARIABLE' ],
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
    [ /^[a-zA-Z_]\w*/, 'IDENTIFIER' ]
];
class Tokenizer {
    initialize(inputString) {
        this._expression = inputString;
        this._currentPos = 0;
        this._parenStack = []; // Stack to track opening parentheses positions
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

                // Track parentheses and detect excess closing immediately
                if (token === '(') {
                    this._parenStack.push(tokenStartPos); // Push position of opening parenthesis
                } else if (token === ')') {
                    if (this._parenStack.length === 0) {
                        const expressionSnippet = this._expression.slice(Math.max(0, tokenStartPos - 10), tokenStartPos + 10);
                        // Excess closing parenthesis detected mid-expression
                        throw new Error(`Unexpected closing parenthesis at position ${tokenStartPos + 1}: ')' ` 
                                        + `without matching '('. Near: '${expressionSnippet}'`);
                    }
                    this._parenStack.pop(); // Match with an opening parenthesis
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

        // Tokenize the input, skipping whitespace and comments
        while (this._tokenizer.hasMoreTokens()) {
            const token = this._tokenizer.getNextToken();
            if (token && token.tokenType !== 'WHITESPACE' && 
                token.tokenType !== 'SINGLE_LINE_COMMENT' && 
                token.tokenType !== 'MULTI_LINE_COMMENT') {
                this._tokens.push(token);
            }
        }

        // Check parentheses balance after tokenization
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
        // Handles logical operators && and ||
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
            this.peek().token === '<' ||          // New
            this.peek().token === '>' ||          // New
            this.peek().token === '<=' ||         // New
            this.peek().token === '>='            // New
        )) {
            const operator = this.consume().token;
            const right = this.parseTerm();
            node = { type: 'Operator', operator, left: node, right };
        }
        return node;
    }

    parseTerm() {
        // Handles + and -
        let node = this.parseFactor();
        while (this.peek() && (this.peek().token === '+' || this.peek().token === '-')) {
            const operator = this.consume().token;
            const right = this.parseFactor();
            node = { type: 'Operator', operator, left: node, right };
        }
        return node;
    }

    parseFactor() {
        // Handles * and /
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
            return { type: 'Literal', value: this.consume().token.slice(1, -1) }; // Remove quotes
        } else if (token.tokenType === 'VARIABLE') {
            return { type: 'Variable', name: this.consume().token.slice(2, -1) }; // Remove {! and }
        } else if (token.tokenType === 'IDENTIFIER') {
            const name = this.consume().token;
            if (this.peek() && this.peek().token === '(') {
                this.consume('PARENTHESIS'); // Consume '('
                const args = [];
                while (this.peek() && this.peek().token !== ')') {
                    args.push(this.parseExpression()); // Parse full expressions as arguments
                    if (this.peek() && this.peek().token === ',') {
                        this.consume('COMMA');
                    } else {
                        break;
                    }
                }
                this.consume('PARENTHESIS'); // Consume ')'
                return { type: 'Function', name, arguments: args };
            } else {
                throw new Error(`Unexpected identifier: ${name}`);
            }
        } else if (token.token === '(') {
            this.consume('PARENTHESIS'); // Consume '('
            const expr = this.parseExpression();
            this.consume('PARENTHESIS'); // Consume ')'
            return expr;
        } else {
            throw new Error(`Unexpected token: ${token.token}`);
        }
    }
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
                    return args[args.length - 1]; // Default value
                default: throw new Error(`Unsupported function: ${ast.name}`);
            }

        case "Operator":
            const left = calculateFormula(ast.left, variables);
            const right = calculateFormula(ast.right, variables);
            switch (ast.operator) {
                case "+": return typeof left === "string" || typeof right === "string" ? 
                                    String(left) + String(right) 
                                    : (parseFloat(left) || 0) + (parseFloat(right) || 0);
                case "-": return (parseFloat(left) || 0) - (parseFloat(right) || 0);
                case "*": return (parseFloat(left) || 0) * (parseFloat(right) || 0);
                case "/":
                    const divisor = parseFloat(right) || 0;
                    if (divisor === 0) throw new Error("Division by zero");
                    return (parseFloat(left) || 0) / divisor;
                case "&&": return Boolean(left) && Boolean(right);
                case "||": return Boolean(left) || Boolean(right);
                case "=": return left === right;
                case "<>": return left !== right;
                case "!=": return left !== right;
                case "<": return (parseFloat(left) || 0) < (parseFloat(right) || 0);
                case ">": return (parseFloat(left) || 0) > (parseFloat(right) || 0);
                case "<=": return (parseFloat(left) || 0) <= (parseFloat(right) || 0);
                case ">=": return (parseFloat(left) || 0) >= (parseFloat(right) || 0);
                default: throw new Error(`Unsupported operator: ${ast.operator}`);
            }

        case "Variable":
            return variables[ast.name] !== undefined ? variables[ast.name] : "";

        case "Literal":
            return ast.value;

        default:
            throw new Error(`Unknown AST node type: ${ast.type}`);
    }
}

function extractVariables(ast) {
    const variables = new Set(); // Use Set for unique variables

    function traverse(node) {
        if (!node) return;

        switch (node.type) {
            case "Variable":
                variables.add(node.name); // Add variable name to the set
                break;

            case "Function":
                // Traverse each argument in the function
                node.arguments.forEach(arg => traverse(arg));
                break;

            case "Operator":
                // Traverse left and right operands
                traverse(node.left);
                traverse(node.right);
                break;

            case "Literal":
                // No variables here, so do nothing
                break;

            default:
                throw new Error(`Unknown AST node type: ${node.type}`);
        }
    }

    traverse(ast);
    return Array.from(variables); // Convert Set to Array
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

            case "Variable":
            case "Literal":
                break;

            default:
                throw new Error(`Unknown AST node type: ${node.type}`);
        }
    }

    traverse(ast);
    return steps;
}

function rebuildFormula(ast) {
    if (!ast || !ast.type ) return "";

    switch (ast.type) {
        case "Function":
            // Rebuild function: NAME(arg1, arg2, ...)
            const args = ast.arguments.map(arg => rebuildFormula(arg)).join(", ");
            return `${ast.name}( ${args} )`;

        case "Operator":
            // Rebuild operator: left OP right
            const left = rebuildFormula(ast.left);
            const right = rebuildFormula(ast.right);
            // Add spaces around operators for readability
            return `${left} ${ast.operator} ${right}`;

        case "Variable":
            // Rebuild variable: {!variableName}
            return `{!${ast.name}}`;

        case "Literal":
            // Rebuild literal: quote strings, leave numbers as-is
            if (typeof ast.value === "string") {
                return `"${ast.value}"`; // Add quotes around string literals
            }
            return ast.value.toString(); // Numbers or other types

        default:
            throw new Error(`Unknown AST node type: ${ast.type}`);
    }
}

function getVariableValues( theStructure) {
    const variables = extractVariables(theStructure);
    const values = {};
    variables.forEach(variable => {
        const input = document.getElementById(`var-${variable}`);
        values[variable] = input.value || ""; // Default to empty string if no input
    });
    return values;
}

function displayDataStructure(theStructure) {
    const treeList = document.getElementById('treeList');

    const pre = document.createElement('pre');
    let formattedJson = JSON.stringify(theStructure, null, 2);
    formattedJson = formattedJson.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    pre.textContent = formattedJson; // Set as text, not HTML

    const theVariablesList = document.getElementById('variablesList');
    theVariablesList.textContent = '';
    const variables = extractVariables(theStructure);
    variables.forEach(variable => {
        const li = document.createElement('li');
        
        // Create a label for the variable name
        const label = document.createElement('span');
        label.textContent = `${variable}: `;
        
        // Create an input field
        const input = document.createElement('input');
        input.type = 'text';
        input.id = `var-${variable}`; // Unique ID for later retrieval
        input.placeholder = `Enter value for ${variable}`;
        
        // Append label and input to the list item
        li.appendChild(label);
        li.appendChild(input);
        
        // Add the list item to the UL
        theVariablesList.appendChild(li);
    });

    const rebuiltFormula = rebuildFormula(theStructure);
    const preFormula = document.createElement('pre');
    preFormula.textContent = `Rebuilt Formula:\n${rebuiltFormula}`;

    const theStepsList = document.getElementById('stepsList');
    theStepsList.textContent = '';
    const steps = extractCalculationSteps(theStructure);
    steps.forEach(step => {
        const container = document.createElement('div');
        container.classList = [ 'stepContainer' ];
        const exprDiv = document.createElement('div');
        exprDiv.textContent = step.expression;
        container.appendChild(exprDiv);
        theStepsList.appendChild(container);
    });

    treeList.innerHTML = '';
    treeList.appendChild(pre);
    treeList.appendChild(preFormula);
}

function displayError( error ) {
    const errorMsg = document.getElementById('errors');
    if( ! error ) {
        errorMsg.innerHTML = '';
        return;
    }
    console.error( "Error: " + error.message + "\n" + error.stack );

    // Parse the position from the error message
    let msg = error.message;
    const match = error.message.match( /position (\d+)/ );
    if (match) {
        const position = parseInt( match[ 1 ] ); // 1-based position
        const formula = document.getElementById('formulaInput').value.trim();
        const indicator = ' '.repeat( position - 1 ) + '^';

        // Display the formula, indicator, and error message
        msg += `<br />
            <pre class="smallFont" >${formula}</pre>
            <pre class="smallFont" >${indicator} ${error.message}</pre>`;
        // document.getElementById('treeList').innerHTML = `
        //     <pre>${formula}</pre>
        //     <pre>${indicator} ${error.message}</pre>`;
    }

    errorMsg.innerHTML = msg;
}

function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
}

function parseFormula( inputValue ) {
    displayError( null );
    const parser = new Parser();
    parsedAST = parser.parse(inputValue.trim());
    displayDataStructure( parsedAST );
}

const formulaInput = document.getElementById('formulaInput');
let parsedAST;
// Add event listener on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    
    const debouncedParse = debounce( (inputValue) => {
        try {
            parseFormula( inputValue );
        } catch (error) {
            displayError( error );
        }
    }, 500 );

    // Auto-parse on input
    formulaInput.addEventListener( 'input', (e) => {
        debouncedParse( e.target.value.trim() );
    });
    
    const calculateButton = document.getElementById('calculateButton');
    if (calculateButton) {
        calculateButton.addEventListener("click", () => {
            if( !parsedAST ) {
                return;
            }
            const vars = getVariableValues( parsedAST );
            let result;
            try {
                result = calculateFormula(parsedAST, vars);
            } catch (error) {
                result = `Error: ${error.message}`;
            }
            document.getElementById('result').textContent = `Result:\n${result}`;

            const theStepsList = document.getElementById('stepsList');
            theStepsList.innerHTML = ''; // Clear the list
            const steps = extractCalculationSteps( parsedAST );

            steps.forEach((step, index) => {
    
                // Create a container div with a border
                const container = document.createElement('div');
                container.classList = [ 'stepContainer' ];
                
                // Expression on its own line
                const exprDiv = document.createElement('div');
                exprDiv.textContent = `${index + 1}. ${step.expression}`;
                
                // Result on a separate line
                let result;
                try {
                    result = calculateFormula(step.node, vars);
                } catch (error) {
                    result = `Error: ${error.message}`;
                }
                const resultDiv = document.createElement('div');
                resultDiv.textContent = `= ${result}`;
                
                // Append expression and result to the container
                container.appendChild(exprDiv);
                container.appendChild(resultDiv);
                
                // Add the container to the list item
                theStepsList.appendChild(container);
            });
        });
    }

    if( formulaInput.value ) {
        parseFormula( formulaInput.value.trim() );
    }

});