// script-lang 错误消息本地化：本体保持英文（跨端 Kotlin 一致），在展示边界按模式
// 翻译成当前语言，未匹配回退原文。翻译键在 langs.js 的 err.script.* 下。

import { LANGS } from './langs.js';
import { LANG } from './i18n.js';

// 每条为 { re, key }。顺序即匹配优先级：更具体的模式放在前面。
export const SCRIPT_ERROR_PATTERNS = [
  // —— tokenizer ——
  { re: /^unterminated block comment$/, key: 'err.script.unterminatedBlockComment' },
  { re: /^unterminated string literal$/, key: 'err.script.unterminatedString' },
  { re: /^unexpected character '(.*)'$/, key: 'err.script.unexpectedChar' },

  // —— parser ——
  { re: /^expected '([^']*)' ([^,]+), got '([^']*)'$/, key: 'err.script.expectedWhat' },
  { re: /^expected '([^']*)', got '([^']*)'$/, key: 'err.script.expected' },
  { re: /^expected identifier, got '(.*)'$/, key: 'err.script.expectedIdentifier' },
  { re: /^duplicate lifecycle function '(.*)'$/, key: 'err.script.duplicateLifecycle' },
  { re: /^'setup' must not take parameters$/, key: 'err.script.setupNoParams' },
  { re: /^'tick' must not take parameters$/, key: 'err.script.tickNoParams' },
  { re: /^'process' must take exactly one parameter \(delta milliseconds\)$/, key: 'err.script.processOneParam' },
  { re: /^reserved name cannot be used as function name: '(.*)'$/, key: 'err.script.reservedFuncName' },
  { re: /^reserved name cannot be used as parameter: '(.*)'$/, key: 'err.script.reservedParamName' },
  { re: /^reserved name cannot be used as loop variable: '(.*)'$/, key: 'err.script.reservedLoopVar' },
  { re: /^reserved name cannot be declared: '(.*)'$/, key: 'err.script.reservedDecl' },
  { re: /^'break' outside loop$/, key: 'err.script.breakOutsideLoop' },
  { re: /^'continue' outside loop$/, key: 'err.script.continueOutsideLoop' },
  { re: /^'return' only allowed inside a function$/, key: 'err.script.returnOutsideFunc' },
  { re: /^'global' only allowed inside setup$/, key: 'err.script.globalOutsideSetup' },
  { re: /^expression statement must be a function call$/, key: 'err.script.exprStmtNotCall' },
  { re: /^destructuring assignment names must be identifiers$/, key: 'err.script.destructureIdent' },
  { re: /^invalid assignment target$/, key: 'err.script.invalidAssignTarget' },
  { re: /^invalid assignment target '(.*)'$/, key: 'err.script.invalidAssignTarget2' },
  { re: /^unexpected token '(.*)'$/, key: 'err.script.unexpectedToken' },
  { re: /^unexpected '(.*)' after expression$/, key: 'err.script.unexpectedAfterExpr' },

  // —— runtime：上下文 / 作用域 ——
  { re: /^'this' is not a value; use this\.<field>$/, key: 'err.script.thisNotValue' },
  { re: /^unknown variable '(.*)'$/, key: 'err.script.unknownVariable' },
  { re: /^cannot assign to 'this'; use this\.<field> = \.\.\.$/, key: 'err.script.assignThis' },
  { re: /^global '(.*)' is read-only here$/, key: 'err.script.globalReadonly' },
  { re: /^cannot assign to read-only name '(.*)'$/, key: 'err.script.readonlyName' },
  { re: /^only this has fields '\.(.*)'$/, key: 'err.script.onlyThisFields' },
  { re: /^this\.(.*) is read-only$/, key: 'err.script.thisFieldReadonly' },
  { re: /^only this \/ particle have fields '\.(.*)'$/, key: 'err.script.onlyThisParticleFields' },
  { re: /^indexed assignment target is not an array$/, key: 'err.script.indexedTargetNotArray' },
  { re: /^array index (.*) out of bounds \(size (.*)\)$/, key: 'err.script.arrayIndexOob' },
  { re: /^particle list index (.*) out of bounds \(size (.*)\)$/, key: 'err.script.particleIndexOob' },
  { re: /^insert index (.*) out of bounds \(size (.*)\)$/, key: 'err.script.insertIndexOob' },
  { re: /^remove index (.*) out of bounds \(size (.*)\)$/, key: 'err.script.removeIndexOob' },
  { re: /^component assignment target is not a vector$/, key: 'err.script.compTargetNotVec' },
  { re: /^(vec2|vec3|vec4) has no component '(.*)'$/, key: 'err.script.vecNoComponent' },
  { re: /^unknown statement type '(.*)'$/, key: 'err.script.unknownStmtType' },
  { re: /^unknown expression type '(.*)'$/, key: 'err.script.unknownExprType' },
  { re: /^cannot compile statement type '(.*)'$/, key: 'err.script.cannotCompileStmt' },
  { re: /^cannot compile expression type '(.*)'$/, key: 'err.script.cannotCompileExpr' },
  { re: /^loop iteration limit \((.*)\) exceeded$/, key: 'err.script.loopLimit' },
  { re: /^for-of requires a particle list or array, got (.*)$/, key: 'err.script.forOfRequiresList' },
  { re: /^'!' requires a num\/bool, got (.*)$/, key: 'err.script.notRequiresNumBool' },
  { re: /^unary '-' not supported for (.*)$/, key: 'err.script.unaryMinusType' },
  { re: /^'&&' requires num\/bool operands, got (.*)$/, key: 'err.script.andRequiresNumBool' },
  { re: /^'\|\|' requires num\/bool operands, got (.*)$/, key: 'err.script.orRequiresNumBool' },
  { re: /^index access requires an array or particle list, got (.*)$/, key: 'err.script.indexRequiresList' },
  { re: /^index access requires an array, got (.*)$/, key: 'err.script.indexRequiresArray' },
  { re: /^component access requires a vector, got (.*)$/, key: 'err.script.compRequiresVec' },
  { re: /^particle has no method '\.(.*)\(\)'$/, key: 'err.script.particleNoMethod' },
  { re: /^particle list has no method '\.(.*)\(\)'$/, key: 'err.script.particleListNoMethod' },
  { re: /^method '\.(.*)\(\)' requires an array, particle or particle list, got (.*)$/, key: 'err.script.methodRequiresReceiver' },
  { re: /^method '\.(.*)\(\)' requires an array, got (.*)$/, key: 'err.script.methodRequiresArray' },
  { re: /^function not found$/, key: 'err.script.functionNotFound' },
  { re: /^function '(.*)' not found$/, key: 'err.script.functionNameNotFound' },
  { re: /^maximum recursion depth \((.*)\) exceeded$/, key: 'err.script.maxRecursion' },
  { re: /^this\.spawn is not available here$/, key: 'err.script.spawnUnavailable' },
  { re: /^spawn failed$/, key: 'err.script.spawnFailed' },
  { re: /^'kill' takes no arguments$/, key: 'err.script.killNoArgs' },
  { re: /^unknown this field '\.(.*)'$/, key: 'err.script.unknownThisField' },
  { re: /^this\.(.*) is not available here$/, key: 'err.script.thisFieldUnavailable' },
  { re: /^particle\.color requires a vec3, vec4, \[r,g,b\] or \[r,g,b,a\], got (.*)$/, key: 'err.script.particleColorType' },
  { re: /^particle\.glow requires a num\/bool, got (.*)$/, key: 'err.script.particleGlowType' },
  { re: /^particle\.index is read-only$/, key: 'err.script.particleIndexReadonly' },
  { re: /^cannot unpack (.*) components into (.*) names$/, key: 'err.script.unpackComponents' },
  { re: /^cannot unpack array of length (.*) into (.*) names$/, key: 'err.script.unpackArrayLen' },
  { re: /^unpack requires a vector or array, got (.*)$/, key: 'err.script.unpackType' },
  { re: /^condition requires a num\/bool, got (.*)$/, key: 'err.script.condRequiresNumBool' },
  { re: /^'(\+\+|--)' operand requires a num, got (.*)$/, key: 'err.script.incOperand' },

  // —— runtime：类型 / 运算 ——
  { re: /^(.*) requires a vec(2|3|4) or array of (?:2|3|4) numbers, got (.*)$/, key: 'err.script.requiresVecOrArray' },
  { re: /^(.*) requires an array of (.*) numbers, got length (.*)$/, key: 'err.script.requiresArrayN' },
  { re: /^(.*) requires a vec(2|3|4), got (.*)$/, key: 'err.script.requiresVecN' },
  { re: /^(.*) requires a vec2\/vec3\/vec4, got (.*)$/, key: 'err.script.requiresVec' },
  { re: /^(.*) requires an array, got (.*)$/, key: 'err.script.requiresArray' },
  { re: /^(.*) requires an integer, got (.*)$/, key: 'err.script.requiresInt' },
  { re: /^(.*) requires a num, got (.*)$/, key: 'err.script.requiresNum' },
  { re: /^vector dimension mismatch$/, key: 'err.script.vecDimMismatch' },
  { re: /^matrix dimension mismatch$/, key: 'err.script.matDimMismatch' },
  { re: /^operator '(.*)' not supported for (.*) and (.*)$/, key: 'err.script.opNotSupported' },
  { re: /^operator '(.*)' only supports nums, got (.*) and (.*)$/, key: 'err.script.opOnlyNums' },
  { re: /^operator '(.*)' requires num\/bool, got (.*)$/, key: 'err.script.opRequiresNumBool' },
  { re: /^unknown operator '(.*)'$/, key: 'err.script.unknownOperator' },
  { re: /^mat3 requires a vec3 operand$/, key: 'err.script.mat3NeedsVec3' },
  { re: /^mat4 requires a vec3 or vec4 operand$/, key: 'err.script.mat4NeedsVec' },

  // —— runtime：数组 / 方法 ——
  { re: /^push expects 1 argument$/, key: 'err.script.pushArgs' },
  { re: /^insert expects 2 arguments$/, key: 'err.script.insertArgs' },
  { re: /^remove expects 1 argument$/, key: 'err.script.removeArgs' },
  { re: /^slice expects at most 2 arguments$/, key: 'err.script.sliceArgs' },
  { re: /^size expects no arguments$/, key: 'err.script.sizeArgs' },
  { re: /^find expects 1 argument$/, key: 'err.script.findArgs' },
  { re: /^includes expects 1 argument$/, key: 'err.script.includesArgs' },
  { re: /^sort expects at most 1 argument$/, key: 'err.script.sortArgs' },
  { re: /^unique expects no arguments$/, key: 'err.script.uniqueArgs' },
  { re: /^reverse expects no arguments$/, key: 'err.script.reverseArgs' },
  { re: /^(.*) expects (\d+)\.\.(\d+) argument\(s\), got (\d+)$/, key: 'err.script.arityRange' },
  { re: /^(.*) expects at least (\d+) argument\(s\), got (\d+)$/, key: 'err.script.arityAtLeast' },
  { re: /^(.*) expects (\d+) argument\(s\), got (\d+)$/, key: 'err.script.arityMismatch' },
  { re: /^sort comparator must be a function, got (.*)$/, key: 'err.script.comparatorType' },
  { re: /^comparator function '(.*)' not found$/, key: 'err.script.comparatorNotFound' },
  { re: /^comparator function must return a num$/, key: 'err.script.comparatorReturn' },
  { re: /^unknown array method '\.(.*)\(\)'$/, key: 'err.script.unknownArrayMethod' },

  // —— runtime：内建细节 ——
  { re: /^cannot normalize a zero-length vector$/, key: 'err.script.normalizeZero' },
  { re: /^operation not supported for (.*)$/, key: 'err.script.opNotSupportedFor' },
  { re: /^lerp requires two nums or two vectors, got (.*) and (.*)$/, key: 'err.script.lerpType' },
  { re: /^clamp bound dimension mismatch$/, key: 'err.script.clampBoundMismatch' },
  { re: /^clamp not supported for (.*)$/, key: 'err.script.clampType' },
  { re: /^mat3 rows must be vec3$/, key: 'err.script.mat3RowsVec3' },
  { re: /^translate requires a vec3$/, key: 'err.script.translateVec3' },
  { re: /^scale not supported for (.*)$/, key: 'err.script.scaleType' },
  { re: /^lookAt requires vec3 arguments$/, key: 'err.script.lookAtVec3' },
  { re: /^cross requires vec3 operands$/, key: 'err.script.crossVec3' },
  { re: /^project onto zero-length vector$/, key: 'err.script.projectZero' },
  { re: /^map_range input range is empty$/, key: 'err.script.mapRangeEmpty' },
  { re: /^remap input range is empty$/, key: 'err.script.remapEmpty' },
  { re: /^bool requires a num\/bool, got (.*)$/, key: 'err.script.boolType' },
  { re: /^mod by zero$/, key: 'err.script.modZero' },
  { re: /^division by zero$/, key: 'err.script.divZero' },
  { re: /^fbm octaves must be at least 1$/, key: 'err.script.fbmOctaves' },
  { re: /^cannot sort mixed types \((.*) vs (.*)\)$/, key: 'err.script.sortMixed' },
  { re: /^values of type (.*) are not sortable$/, key: 'err.script.sortType' },
  { re: /^unknown builtin '(.*)'$/, key: 'err.script.unknownBuiltin' },
  { re: /^value of type (.*) is not callable$/, key: 'err.script.notCallable' },
  { re: /^lookAt target equals eye$/, key: 'err.script.lookAtEye' },
  { re: /^lookAt up is parallel to view direction$/, key: 'err.script.lookAtUp' },
  { re: /^expression must evaluate to a number, got (.*)$/, key: 'err.script.exprNotNumber' },
];

const LOC_RE = /^(.*?)\s*\(line (\d+), col (\d+)\)$/;

function format(tpl, args) {
  return String(tpl == null ? '' : tpl).replace(/\{(\d+)\}/g, (m, i) => {
    const v = args[+i];
    return v != null ? String(v) : m;
  });
}

/**
 * 把 script-lang 的英文错误消息本地化；保留行号后缀。
 * lang 可显式传入（测试用），默认取当前 UI 语言。
 */
export function localizeScriptError(message, lang = LANG) {
  const msg = message == null ? '' : String(message);
  if (lang === 'en') return msg; // 英文源文即最终展示
  const loc = LOC_RE.exec(msg);
  const body = loc ? loc[1] : msg;
  const suffix = loc ? ` (line ${loc[2]}, col ${loc[3]})` : '';
  const table = LANGS[lang] || LANGS.en || {};
  for (const p of SCRIPT_ERROR_PATTERNS) {
    const m = p.re.exec(body);
    if (!m) continue;
    const tpl = table[p.key] != null ? table[p.key] : (LANGS.en && LANGS.en[p.key]);
    if (tpl != null) return format(tpl, m.slice(1)) + suffix;
  }
  return msg;
}