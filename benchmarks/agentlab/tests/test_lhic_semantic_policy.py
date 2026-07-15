import unittest

from lhic_semantic_policy import extract_semantic_controls, propose_action


class LhicSemanticPolicyTests(unittest.TestCase):
    def test_extracts_semantic_search_control(self) -> None:
        controls = extract_semantic_controls(
            '<input bid="search-42" type="search" aria-label="Search docs">'
        )

        self.assertEqual(len(controls), 1)
        self.assertEqual(controls[0].bid, "search-42")
        self.assertEqual(controls[0].accessible_name, "Search docs")

    def test_uses_bid_actions_for_an_explicit_search(self) -> None:
        html = '<input bid="search-42" aria-label="Search docs">'

        first = propose_action("Search for release notes", html)
        second = propose_action("Search for release notes", html, first.phase)

        self.assertEqual(first.action, 'fill("search-42", "release notes")')
        self.assertEqual(second.action, 'press("search-42", \'ENTER\')')

    def test_refuses_destructive_and_unsupported_goals(self) -> None:
        html = '<input bid="search-42" aria-label="Search docs">'

        destructive = propose_action("Delete the production record", html)
        unsupported = propose_action("Open the settings page", html)

        self.assertTrue(destructive.action.startswith("report_infeasible("))
        self.assertTrue(unsupported.action.startswith("report_infeasible("))

    def test_fills_a_matching_semantic_form_control_once(self) -> None:
        html = '<input bid="name-7" aria-label="Full name">'

        first = propose_action("Fill full name with Ada", html)
        second = propose_action("Fill full name with Ada", html, first.phase)

        self.assertEqual(first.action, 'fill("name-7", "Ada")')
        self.assertTrue(second.action.startswith("report_infeasible("))


if __name__ == "__main__":
    unittest.main()
