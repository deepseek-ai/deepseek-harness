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
        return SchemaBuilder.object(["argument": argument(for: target.attribute)], required: ["argument"])
    }

    /// Without an element, only a name-determined type is definite; other attributes accept every supported kind.
    private static func argument(for attribute: String) -> JSONValue {
        guard let kind = AXAccess.knownValueKind(attribute: attribute) else {
            return SchemaBuilder.oneOf(AXAccess.AttributeValueKind.allCases.map { schema(for: $0) },
                description: "The accepted value type depends on the element's live attribute value type.")
        }
        return schema(for: kind)
    }

    private static func schema(for kind: AXAccess.AttributeValueKind) -> JSONValue {
        switch kind {
        case .string: return SchemaBuilder.scalar("string")
        case .boolean: return SchemaBuilder.scalar("boolean")
        case .number: return SchemaBuilder.scalar("number", description: "A finite number.")
        case .point:
            return SchemaBuilder.object([
                "x": SchemaBuilder.scalar("number", description: "A finite x coordinate."),
                "y": SchemaBuilder.scalar("number", description: "A finite y coordinate."),
            ], required: ["x", "y"])
        case .size:
            return SchemaBuilder.object([
                "width": SchemaBuilder.scalar("number", description: "A nonnegative finite width."),
                "height": SchemaBuilder.scalar("number", description: "A nonnegative finite height."),
            ], required: ["width", "height"])
        case .range:
            return SchemaBuilder.object([
                "location": SchemaBuilder.scalar("number", description: "A nonnegative integer no greater than \(Int.max)."),
                "length": SchemaBuilder.scalar("number", description: "A nonnegative integer no greater than \(Int.max)."),
            ], required: ["location", "length"],
                description: "The sum of location and length must be no greater than \(Int.max).")
        }
    }
}

/// Builds fresh schema nodes, each optionally annotated with a model-facing description.
private enum SchemaBuilder {
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
