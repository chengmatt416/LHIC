import unittest

from tool_agent_core import (
    ToolCallValidationError,
    build_system_prompt,
    validate_tool_call,
)


SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "update_order",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "order_id": {"type": "string", "minLength": 1},
                    "quantity": {"type": "integer", "minimum": 1},
                    "status": {"$ref": "#/$defs/status"},
                },
                "required": ["order_id", "quantity", "status"],
                "$defs": {
                    "status": {"type": "string", "enum": ["pending", "confirmed"]}
                },
            },
        },
    }
]


class ToolAgentCoreTests(unittest.TestCase):
    def test_accepts_exact_schema_and_parses_json_arguments(self) -> None:
        call = validate_tool_call(
            SCHEMAS,
            "update_order",
            '{"order_id":"A-12","quantity":2,"status":"confirmed"}',
        )
        self.assertEqual(call.name, "update_order")
        self.assertEqual(call.arguments["quantity"], 2)

    def test_rejects_unknown_and_missing_arguments_before_execution(self) -> None:
        with self.assertRaisesRegex(ToolCallValidationError, "unknown field"):
            validate_tool_call(
                SCHEMAS,
                "update_order",
                {"order_id": "A-12", "quantity": 2, "status": "pending", "force": True},
            )
        with self.assertRaisesRegex(ToolCallValidationError, "missing required"):
            validate_tool_call(
                SCHEMAS,
                "update_order",
                {"order_id": "A-12", "status": "pending"},
            )

    def test_rejects_implicit_type_coercion_and_duplicate_json_keys(self) -> None:
        with self.assertRaisesRegex(ToolCallValidationError, "must be integer"):
            validate_tool_call(
                SCHEMAS,
                "update_order",
                {"order_id": "A-12", "quantity": "2", "status": "pending"},
            )
        with self.assertRaisesRegex(ToolCallValidationError, "duplicate argument"):
            validate_tool_call(
                SCHEMAS,
                "update_order",
                '{"order_id":"A-12","order_id":"B-9","quantity":2,"status":"pending"}',
            )

    def test_rejects_unknown_tool_and_bad_enum(self) -> None:
        with self.assertRaisesRegex(ToolCallValidationError, "unknown tool"):
            validate_tool_call(SCHEMAS, "delete_everything", {})
        with self.assertRaisesRegex(ToolCallValidationError, "allowed values"):
            validate_tool_call(
                SCHEMAS,
                "update_order",
                {"order_id": "A-12", "quantity": 2, "status": "complete"},
            )

    def test_prompt_requires_receipts_and_policy_prerequisites(self) -> None:
        prompt = build_system_prompt("Verify identity before account access.")
        self.assertIn("Verify identity before account access.", prompt)
        self.assertIn("policy prerequisite", prompt)
        self.assertIn("Never claim completion", prompt)
        self.assertIn("must not be repeated", prompt)


if __name__ == "__main__":
    unittest.main()
