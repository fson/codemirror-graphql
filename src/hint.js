/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import CodeMirror from 'codemirror';
import {
  isInputType,
  isCompositeType,
  isAbstractType,
  getNullableType,
  getNamedType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLBoolean,
} from 'graphql/type';
import {
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
} from 'graphql/type/introspection';


/**
 * Registers a "hint" helper for CodeMirror.
 *
 * Using CodeMirror's "hint" addon: https://codemirror.net/demo/complete.html
 * Given an editor, this helper will take the token at the cursor and return a
 * list of suggested tokens.
 *
 * Options:
 *
 *   - schema: GraphQLSchema provides the hinter with positionally relevant info
 *
 * Additional Events:
 *
 *   - hasCompletion (codemirror, data, token) - signaled when the hinter has a
 *     new list of completion suggestions.
 *
 */
CodeMirror.registerHelper('hint', 'graphql', (editor, options) => {
  var schema = options.schema;
  if (!schema) {
    return;
  }

  var cur = editor.getCursor();
  var token = editor.getTokenAt(cur);
  var typeInfo = getTypeInfo(schema, token.state);

  var state = token.state;
  var kind = state.kind;
  var step = state.step;

  if (token.type === 'comment') {
    return;
  }

  // Definition kinds
  if (kind === 'Document') {
    return hintList(editor, options, cur, token, [
      { text: 'query' },
      { text: 'mutation' },
      { text: 'subscription' },
      { text: 'fragment' },
      { text: '{' },
    ]);
  }

  // Field names
  if (kind === 'SelectionSet' || kind === 'Field' || kind === 'AliasedField') {
    if (typeInfo.parentType) {
      var fields;
      if (typeInfo.parentType.getFields) {
        var fieldObj = typeInfo.parentType.getFields();
        fields = Object.keys(fieldObj).map(fieldName => fieldObj[fieldName]);
      } else {
        fields = [];
      }
      if (isAbstractType(typeInfo.parentType)) {
        fields.push(TypeNameMetaFieldDef);
      }
      if (typeInfo.parentType === schema.getQueryType()) {
        fields.push(SchemaMetaFieldDef, TypeMetaFieldDef);
      }
      return hintList(editor, options, cur, token, fields.map(field => ({
        text: field.name,
        type: field.type,
        description: field.description
      })));
    }
  }

  // Argument names
  if (kind === 'Arguments' || kind === 'Argument' && step === 0) {
    var argDefs = typeInfo.argDefs;
    if (argDefs) {
      return hintList(editor, options, cur, token, argDefs.map(argDef => ({
        text: argDef.name,
        type: argDef.type,
        description: argDef.description
      })));
    }
  }

  // Input Object fields
  if (kind === 'ObjectValue' || kind === 'ObjectField' && step === 0) {
    if (typeInfo.objectFieldDefs) {
      var objectFields = Object.keys(typeInfo.objectFieldDefs)
        .map(fieldName => typeInfo.objectFieldDefs[fieldName]);
      return hintList(editor, options, cur, token, objectFields.map(field => ({
        text: field.name,
        type: field.type,
        description: field.description
      })));
    }
  }

  // Input values: Enum and Boolean
  if (kind === 'EnumValue' ||
      kind === 'ListValue' && step === 1 ||
      kind === 'ObjectField' && step === 2 ||
      kind === 'Argument' && step === 2) {
    var namedInputType = getNamedType(typeInfo.inputType);
    if (namedInputType instanceof GraphQLEnumType) {
      var valueMap = namedInputType.getValues();
      var values = Object.keys(valueMap).map(valueName => valueMap[valueName]);
      return hintList(editor, options, cur, token, values.map(value => ({
        text: value.name,
        type: namedInputType,
        description: value.description
      })));
    } else if (namedInputType === GraphQLBoolean) {
      return hintList(editor, options, cur, token, [
        { text: 'true', type: GraphQLBoolean, description: 'Not false.' },
        { text: 'false', type: GraphQLBoolean, description: 'Not true.' },
      ]);
    }
  }

  // Fragment type conditions
  if (kind === 'TypeCondition' && step === 1 ||
      kind === 'NamedType' && state.prevState.kind === 'TypeCondition') {
    var possibleTypes;
    if (typeInfo.parentType) {
      possibleTypes = isAbstractType(typeInfo.parentType) ?
        typeInfo.parentType.getPossibleTypes() :
        [ typeInfo.parentType ];
    } else {
      var typeMap = schema.getTypeMap();
      possibleTypes = Object.keys(typeMap)
        .map(typeName => typeMap[typeName])
        .filter(isCompositeType);
    }
    return hintList(editor, options, cur, token, possibleTypes.map(type => ({
      text: type.name,
      description: type.description
    })));
  }

  // Variable definition types
  if (kind === 'VariableDefinition' && step === 2 ||
      kind === 'ListType' && step === 1 ||
      kind === 'NamedType' && (
        state.prevState.kind === 'VariableDefinition' ||
        state.prevState.kind === 'ListType')) {
    var inputTypeMap = schema.getTypeMap();
    var inputTypes = Object.keys(inputTypeMap)
      .map(typeName => inputTypeMap[typeName])
      .filter(isInputType);
    return hintList(editor, options, cur, token, inputTypes.map(type => ({
      text: type.name,
      description: type.description
    })));
  }

  // Directive names
  if (kind === 'Directive') {
    var directives = schema.getDirectives().filter(directive =>
      (directive.onField && state.prevState.kind === 'Field') ||
      (directive.onFragment &&
        (state.prevState.kind === 'FragmentDefinition' ||
         state.prevState.kind === 'InlineFragment' ||
         state.prevState.kind === 'FragmentSpread')) ||
      (directive.onOperation &&
        (state.prevState.kind === 'Query' ||
         state.prevState.kind === 'Mutation' ||
         state.prevState.kind === 'Subscription' ))
    );
    return hintList(editor, options, cur, token, directives.map(directive => ({
      text: directive.name,
      description: directive.description
    })));
  }
});


// Utility for collecting rich type information given any token's state
// from the graphql-mode parser.
function getTypeInfo(schema, tokenState) {
  var info = {
    type: null,
    parentType: null,
    inputType: null,
    directiveDef: null,
    fieldDef: null,
    argDef: null,
    argDefs: null,
    objectFieldDefs: null,
  };

  forEachState(tokenState, state => {
    switch (state.kind) {
      case 'Query': case 'ShortQuery':
        info.type = schema.getQueryType();
        break;
      case 'Mutation':
        info.type = schema.getMutationType();
        break;
      case 'Subscription':
        info.type = schema.getSubscriptionType();
        break;
      case 'InlineFragment':
      case 'FragmentDefinition':
        info.type = state.type && schema.getType(state.type);
        break;
      case 'Field':
        info.fieldDef = info.type && state.name ?
          getFieldDef(schema, info.parentType, state.name) :
          null;
        info.type = info.fieldDef && info.fieldDef.type;
        break;
      case 'SelectionSet':
        info.parentType = getNamedType(info.type);
        break;
      case 'Directive':
        info.directiveDef = state.name && schema.getDirective(state.name);
        break;
      case 'Arguments':
        info.argDefs =
          state.prevState.kind === 'Field' ?
            info.fieldDef && info.fieldDef.args :
          state.prevState.kind === 'Directive' ?
            info.directiveDef && info.directiveDef.args :
            null;
        break;
      case 'Argument':
        info.argDef = null;
        if (info.argDefs) {
          for (var i = 0; i < info.argDefs.length; i++) {
            if (info.argDefs[i].name === state.name) {
              info.argDef = info.argDefs[i];
              break;
            }
          }
        }
        info.inputType = info.argDef && info.argDef.type;
        break;
      case 'ListValue':
        var nullableType = getNullableType(info.inputType);
        info.inputType = nullableType instanceof GraphQLList ?
          nullableType.ofType :
          null;
        break;
      case 'ObjectValue':
        var objectType = getNamedType(info.inputType);
        info.objectFieldDefs = objectType instanceof GraphQLInputObjectType ?
          objectType.getFields() :
          null;
        break;
      case 'ObjectField':
        var objectField = state.name && info.objectFieldDefs ?
          info.objectFieldDefs[state.name] :
          null;
        info.inputType = objectField && objectField.type;
        break;
    }
  });

  return info;
}

// Utility for iterating through a state stack bottom-up.
function forEachState(stack, fn) {
  var reverseStateStack = [];
  var state = stack;
  while (state && state.kind) {
    reverseStateStack.push(state);
    state = state.prevState;
  }
  for (var i = reverseStateStack.length - 1; i >= 0; i--) {
    fn(reverseStateStack[i]);
  }
}

// Gets the field definition given a type and field name
function getFieldDef(schema, type, fieldName) {
  if (fieldName === SchemaMetaFieldDef.name && schema.getQueryType() === type) {
    return SchemaMetaFieldDef;
  }
  if (fieldName === TypeMetaFieldDef.name && schema.getQueryType() === type) {
    return TypeMetaFieldDef;
  }
  if (fieldName === TypeNameMetaFieldDef.name && isCompositeType(type)) {
    return TypeNameMetaFieldDef;
  }
  if (type.getFields) {
    return type.getFields()[fieldName];
  }
}

// Create the expected hint response given a possible list and a token
function hintList(editor, options, cursor, token, list) {
  var hints = filterAndSortList(list, normalizeText(token.string));
  if (!hints) {
    return;
  }

  var tokenStart = token.type === null ? token.end :
    /\w/.test(token.string[0]) ? token.start :
    token.start + 1;

  var results = {
    list: hints,
    from: CodeMirror.Pos(cursor.line, tokenStart),
    to: CodeMirror.Pos(cursor.line, token.end),
  };

  CodeMirror.signal(editor, 'hasCompletion', editor, results, token);

  return results;
}

// Given a list of hint entries and currently typed text, sort and filter to
// provide a concise list.
function filterAndSortList(list, text) {
  var sorted = !text ? list : list.map(
    entry => ({
      proximity: getProximity(normalizeText(entry.text), text),
      entry
    })
  ).filter(
    pair => pair.proximity <= 2
  ).sort(
    (a, b) =>
      (a.proximity - b.proximity) ||
      (a.entry.text.length - b.entry.text.length)
  ).map(
    pair => pair.entry
  );

  return sorted.length > 0 ? sorted : list;
}

function normalizeText(text) {
  return text.toLowerCase().replace(/\W/g, '');
}

// Determine a numeric proximity for a suggestion based on current text.
function getProximity(suggestion, text) {
  // start with lexical distance
  var proximity = lexicalDistance(text, suggestion);
  if (suggestion.length > text.length) {
    // do not penalize long suggestions.
    proximity -= suggestion.length - text.length - 1;
    // penalize suggestions not starting with this phrase
    proximity += suggestion.indexOf(text) === 0 ? 0 : 0.5;
  }
  return proximity;
}

/**
 * Computes the lexical distance between strings A and B.
 *
 * The "distance" between two strings is given by counting the minimum number
 * of edits needed to transform string A into string B. An edit can be an
 * insertion, deletion, or substitution of a single character, or a swap of two
 * adjacent characters.
 *
 * This distance can be useful for detecting typos in input or sorting
 *
 * @param {string} a
 * @param {string} b
 * @return {int} distance in number of edits
 */
function lexicalDistance(a, b) {
  var i;
  var j;
  var d = [];
  var aLength = a.length;
  var bLength = b.length;

  for (i = 0; i <= aLength; i++) {
    d[i] = [ i ];
  }

  for (j = 1; j <= bLength; j++) {
    d[0][j] = j;
  }

  for (i = 1; i <= aLength; i++) {
    for (j = 1; j <= bLength; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;

      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );

      if (i > 1 && j > 1 &&
          a[i - 1] === b[j - 2] &&
          a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }

  return d[aLength][bLength];
}
