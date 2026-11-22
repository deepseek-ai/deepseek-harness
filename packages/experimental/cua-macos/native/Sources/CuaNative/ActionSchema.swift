// Basic argument types and object fields for one action; performAction enforces value constraints.

/// Builds the action-specific `performAction` parameter object schema without reading an element.
enum ActionSchema {
    /// Return the schema for one action name; attribute setters require one direct argument.
    static func parameter(action: String) throws -> JSONValue {
        guard !action.isEmpty else { throw RequestParameters.invalid("Action name must not be empty") }
        guard let target = AXAttributeSetTarget(action) else {
            return SchemaBuilder.object([
                "argument": SchemaBuilder.scalar("null", description: "This action accepts no argument; omit argument or pass null."),
            ], required: [])
        }
        return SchemaBuilder.object(["argument": try target.parameter.schema(attribute: target.attribute)], required: ["argument"])
    }
}

/// Builds fresh schema nodes, each optionally annotated with a model-facing description.
enum SchemaBuilder {
    static func scalar(_ type: String, description: String? = nil) -> JSONValue {
        node(["type": .string(type)], description: description)
    }

    static func object(_ properties: [String: JSONValue], required: [String], description: String? = nil) -> JSONValue {
        node([
            "type": .string("object"),
            "properties": .object(properties),
            "required": .array(required.map(JSONValue.string)),
            "additionalProperties": .bool(false),
        ], description: description)
    }

    static func oneOf(_ alternatives: [JSONValue], description: String? = nil) -> JSONValue {
        node(["oneOf": .array(alternatives)], description: description)
    }

    private static func node(_ fields: [String: JSONValue], description: String?) -> JSONValue {
        var value = fields
        if let description { value["description"] = .string(description) }
        return .object(value)
    }
}
