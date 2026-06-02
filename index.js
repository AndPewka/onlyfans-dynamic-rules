const types = require("@babel/types")
const generate = require("@babel/generator").default
const traverse = require("@babel/traverse").default
const fs = require("fs")
const babel = require("@babel/core")
const path = require("path")

const OBFUSCATED_FILE = process.argv[2] || "obfuscated.js"

let file = fs.readFileSync(OBFUSCATED_FILE, "utf-8")

const ast = babel.parseSync(file)

let decryptFunc
let reshuffleStatement

let shuffledList
let arrayProviderName
let controlNumber
let shuffleOffset

function assertFound(value, name) {
    if (value === undefined || value === null || value === false) {
        throw new Error(`${name} не найден`)
    }
}

function getSignedOffsetFromCode(code) {
    const match = code.match(/([+-])\s*([+-]?\d+)/)

    if (!match) {
        const num = code.match(/\d+/)

        if (!num) {
            throw new Error(`Не смог извлечь offset из: ${code}`)
        }

        return parseInt(num[0], 10)
    }

    const op = match[1]
    const rawNumber = parseInt(match[2], 10)

    if (op === "+") {
        return rawNumber
    }

    return -rawNumber
}

// sort the arguments so that the number always comes first
function numbersFirst(args) {
    return args.sort(function (a, b) {
        if (typeof a === typeof b) {
            if (typeof a === "number") {
                return a - b
            } else {
                return String(a).localeCompare(String(b))
            }
        } else {
            return typeof a === "number" ? -1 : 1
        }
    })
}

function decrypt(a, b) {
    assertFound(decryptFunc, "decryptFunc")

    return eval(`${decryptFunc}(${a}, ${JSON.stringify(b)})`)
}

// get string. only for the shuffle part of the process.
// the other offsets are managed in the function getValueWithOffset
function get_value(a, b) {
    assertFound(shuffleOffset, "shuffleOffset")

    let nFirst = numbersFirst([a, b])

    return decrypt(nFirst[0] + shuffleOffset, nFirst[1])
}

function getValueWithOffset(integer, string, offset) {
    return decrypt(integer + offset, string)
}

function reshuffle() {
    assertFound(decryptFunc, "decryptFunc")
    assertFound(reshuffleStatement, "reshuffleStatement")
    assertFound(shuffledList, "shuffledList")
    assertFound(controlNumber, "controlNumber")
    assertFound(shuffleOffset, "shuffleOffset")

    let lastError = null

    const maxTries = shuffledList.length + 5

    for (let i = 0; i < maxTries; i++) {
        try {
            if (eval(reshuffleStatement) === controlNumber) {
                return
            }
        } catch (e) {
            lastError = e
        }

        shuffledList.push(shuffledList.shift())
    }

    throw new Error(
        `reshuffle не сошелся за ${maxTries} попыток. lastError: ${lastError?.message || "нет"}`
    )
}

traverse(ast, {
    CallExpression(path) {
        if (path.node.arguments[1]?.type === "NumericLiteral") {
            if (path.node.arguments[1].value > 10000) {
                controlNumber = path.node.arguments[1].value
                path.stop()
            }
        }
    },
})

traverse(ast, {
    ArrayExpression(path) {
        if (path.node.elements.length > 10) {
            shuffledList = eval(generate(path.node).code)

            const fn = path.getFunctionParent()

            if (fn?.node?.id?.name) {
                arrayProviderName = fn.node.id.name
            }

            path.stop()
        }
    },
})

traverse(ast, {
    FunctionDeclaration(path) {
        if (decryptFunc) return
        if (path.node.params.length !== 2) return

        const code = generate(path.node).code

        const looksLikeDecrypt =
            code.includes("decodeURIComponent") &&
            code.includes("charCodeAt") &&
            code.includes("256") &&
            (!arrayProviderName || code.includes(`${arrayProviderName}()`))

        if (!looksLikeDecrypt) return

        const clone = types.cloneNode(path.node, true)

        const originalName = clone.id?.name

        if (originalName && code.includes(`${originalName} = function`)) {
            clone.id = null
        }

        const wrapperAst = types.file(types.program([clone]))

        traverse(wrapperAst, {
            CallExpression(innerPath) {
                if (
                    innerPath.node.callee.type === "Identifier" &&
                    innerPath.node.callee.name === arrayProviderName &&
                    innerPath.node.arguments.length === 0
                ) {
                    innerPath.replaceWith(types.identifier("shuffledList"))
                }
            },
        })

        decryptFunc = `(${generate(clone).code})`

        path.stop()
    },
})

traverse(ast, {
    CallExpression(path) {
        if (path.node.callee.name === "parseInt") {
            const ifStatement = path.getStatementParent().node

            reshuffleStatement = generate(ifStatement.test.left).code.replaceAll(
                /parseInt\((.+?)\(/g,
                "parseInt(get_value("
            )

            path.getFunctionParent().traverse({
                FunctionDeclaration(innerPath) {
                    const returnArg = innerPath.node.body.body[0]?.argument

                    if (!returnArg || returnArg.type !== "CallExpression") return

                    const firstArgCode = generate(returnArg.arguments[0]).code

                    shuffleOffset = getSignedOffsetFromCode(firstArgCode)
                },
            })

            path.stop()
        }
    },
})

console.log({
    hasDecryptFunc: Boolean(decryptFunc),
    hasReshuffleStatement: Boolean(reshuffleStatement),
    hasShuffledList: Array.isArray(shuffledList),
    arrayProviderName,
    controlNumber,
    shuffleOffset,
})

reshuffle()

let offsetTable = {}

traverse(ast, {
    ArrowFunctionExpression(path) {
        path.traverse({
            FunctionDeclaration(innerPath) {
                const returnArg = innerPath.node.body.body[0]?.argument

                if (!returnArg || returnArg.type !== "CallExpression") return

                const parentOffset = returnArg.callee.name
                const offsetName = innerPath.node.id?.name

                if (!offsetName) return

                const correctArgument = returnArg.arguments.find(
                    arg => arg.type !== "Identifier"
                )

                if (!correctArgument) return

                const offsetCode = generate(correctArgument).code
                const offset = getSignedOffsetFromCode(offsetCode)

                if (Object.prototype.hasOwnProperty.call(offsetTable, parentOffset)) {
                    offsetTable[offsetName] = offsetTable[parentOffset] + offset
                } else {
                    offsetTable[offsetName] = offset
                }
            },
        })
    },
})

traverse(ast, {
    ArrowFunctionExpression(path) {
        path.traverse({
            CallExpression(path) {
                let name = path.node.callee.name

                if (Object.keys(offsetTable).includes(name)) {
                    if (path.node.arguments.length === 2) {
                        let values = numbersFirst(
                            path.node.arguments
                                .map(argument => {
                                    if (argument.type === "StringLiteral") {
                                        return argument.value
                                    } else if (
                                        argument.type === "UnaryExpression" ||
                                        argument.type === "NumericLiteral"
                                    ) {
                                        return parseInt(generate(argument).code)
                                    }
                                })
                                .filter(v => v !== undefined)
                        )

                        if (values.length !== 2) return

                        try {
                            path.replaceWith(
                                types.stringLiteral(
                                    getValueWithOffset(
                                        values[0],
                                        values[1],
                                        offsetTable[name]
                                    )
                                )
                            )
                        } catch {
                        }
                    }
                }
            },
        })
    },
})

let operatorFunctions = {}

traverse(ast, {
    ObjectExpression(path) {
        if (path.node.properties.length > 10) {
            for (const property of path.node.properties) {
                if (!property.key) continue

                const keyName = property.key.name || property.key.value

                if (property.value.type === "StringLiteral") {
                    operatorFunctions[keyName] = `LITERAL_${property.value.value}`
                } else if (property.value.type === "FunctionExpression") {
                    const argument = property.value.body.body[0]?.argument

                    if (!argument) continue

                    if (argument.type === "BinaryExpression") {
                        operatorFunctions[keyName] = `OPERATION_${argument.operator}`
                    } else {
                        operatorFunctions[keyName] = "OPERATION_CALL"
                    }
                }
            }
        }
    },
})

traverse(ast, {
    CallExpression(path) {
        if (path.node.callee.type === "MemberExpression") {
            let propertyName =
                path.node.callee.property.name || path.node.callee.property.value

            if (Object.keys(operatorFunctions).includes(propertyName)) {
                let operatorFunction = operatorFunctions[propertyName].split("_")

                if (operatorFunction[0] === "OPERATION") {
                    if (operatorFunction[1].length === 1) {
                        let args = path.node.arguments

                        path.replaceWith(
                            types.binaryExpression(
                                operatorFunction[1],
                                args[0],
                                args[1]
                            )
                        )
                    }
                }
            }
        }
    },
})

let checksumIndexes = []
let checksumConstant = 0

let literals = Object.values(operatorFunctions)
    .filter(operatorFunction => operatorFunction.startsWith("LITERAL"))
    .map(operatorFunction => operatorFunction.split("_").slice(1).join("_"))

let staticParam
let start
let end

traverse(ast, {
    ReturnStatement(path) {
        if (path.node.argument?.type === "CallExpression") {
            if (path.node.argument.callee.type === "MemberExpression") {
                path.traverse({
                    BinaryExpression(inner) {
                        if (inner.node.right.type === "NumericLiteral") {
                            let val = inner.node.right.value

                            if (inner.node.operator === "+") {
                                checksumConstant += val
                            } else if (inner.node.operator === "-") {
                                checksumConstant -= val
                            }
                        } else if (
                            inner.node.left.type === "NumericLiteral" &&
                            inner.node.operator === "%"
                        ) {
                            checksumIndexes.push(inner.node.left.value % 40)
                        }
                    },
                })
            }
        }
    },

    CallExpression(path) {
        if (path.node.callee.type === "MemberExpression") {
            const propertyName =
                path.node.callee.property.name || path.node.callee.property.value

            if (propertyName === "join") {
                const separator = path.node.arguments[0]?.value

                if (separator === ":") {
                    const elements = path.node.callee.object.elements

                    const startElement = elements.slice(0, 1)[0]
                    const endElement = elements.slice(-1)[0]

                    if (startElement.type === "MemberExpression") {
                        start = literals.find(literal => literal.length === 5)
                    } else {
                        start = startElement.value
                    }

                    if (endElement.type === "MemberExpression") {
                        end = literals.find(literal => literal.length === 8)
                    } else {
                        end = endElement.value
                    }
                } else if (separator === "\n") {
                    const elements = path.node.callee.object.elements

                    const staticParamElement = elements.slice(0, 1)[0]

                    if (staticParamElement.type === "MemberExpression") {
                        staticParam = literals.find(literal => literal.length === 32)
                    } else {
                        staticParam = staticParamElement.value
                    }
                }
            }
        }
    },
})

checksumIndexes.sort((a, b) => a - b)

const result = {
    staticParam,
    start,
    end,
    checksumConstant,
    checksumIndexes,
    generatedAt: new Date().toISOString(),
}

fs.writeFileSync(
    path.join(__dirname, "result.json"),
    JSON.stringify(result, null, 2)
)

console.log(result)