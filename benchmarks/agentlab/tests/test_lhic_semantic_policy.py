import unittest

from lhic_semantic_policy import (
    PlanState,
    extract_semantic_controls,
    propose_action,
    propose_plan_action,
)


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
        self.assertEqual(second.action, 'press("search-42", \'Enter\')')

    def test_uses_a_searchbox_role_when_its_name_does_not_say_search(self) -> None:
        html = '<input bid="query-7" role="searchbox" aria-label="Products">'

        decision = propose_action("Search for a standing desk", html)

        self.assertEqual(decision.action, 'fill("query-7", "a standing desk")')

    def test_navigates_only_to_an_explicit_http_url(self) -> None:
        decision = propose_action("Visit https://example.test/docs).", "")

        self.assertEqual(decision.action, 'goto("https://example.test/docs")')
        self.assertEqual(decision.phase, "navigated")

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

    def test_uses_an_associated_html_label_for_an_explicit_form_field(self) -> None:
        html = '<label for="caller">Caller</label><input bid="caller-4" id="caller">'

        decision = propose_action("Fill caller with Ada", html)

        self.assertEqual(decision.action, 'fill("caller-4", "Ada")')

    def test_refuses_to_guess_between_multiple_partial_control_matches(self) -> None:
        html = (
            '<input bid="short-description-1" aria-label="Short description">'
            '<input bid="description-2" aria-label="Detailed description">'
        )

        decision = propose_action("Fill description with VPN unavailable", html)

        self.assertTrue(decision.action.startswith("report_infeasible("))

    def test_selects_an_explicit_option_by_semantic_control_name(self) -> None:
        html = '<select bid="priority-2" aria-label="Priority"></select>'

        decision = propose_action("Select priority as high", html)

        self.assertEqual(decision.action, 'select_option("priority-2", "high")')
        self.assertEqual(decision.phase, "selected")

    def test_clicks_a_safe_button_or_link_but_refuses_side_effects(self) -> None:
        safe_html = '<button bid="settings-1">Settings</button>'
        risky_html = '<button bid="delete-1">Delete account</button>'

        safe = propose_action("Open settings page", safe_html)
        risky = propose_action("Click delete account", risky_html)

        self.assertEqual(safe.action, 'click("settings-1")')
        self.assertEqual(safe.phase, "clicked")
        self.assertTrue(risky.action.startswith("report_infeasible("))

    def test_parses_link_text_and_attribute_based_control_names(self) -> None:
        controls = extract_semantic_controls(
            '<a bid="docs-3" title="Documentation">Read docs</a>'
        )

        self.assertEqual(len(controls), 1)
        self.assertEqual(controls[0].tag, "a")
        self.assertEqual(controls[0].accessible_name, "Documentation Read docs")

    def test_parses_and_clicks_an_interactive_div_but_not_a_plain_div(self) -> None:
        controls = extract_semantic_controls(
            '<div bid="all-1" role="button" aria-label="All">All</div>'
            '<div bid="layout-1" aria-label="All">All</div>'
        )

        self.assertEqual([(control.bid, control.tag) for control in controls], [("all-1", "div")])
        decision = propose_action('Open "All"', '<div bid="all-1" role="button" aria-label="All">All</div>')
        self.assertEqual(decision.action, 'click("all-1")')

    def test_parses_generic_interactive_roles_and_ignores_inactive_controls(self) -> None:
        html = (
            '<span bid="menu-1" role="menuitem">Preferences</span>'
            '<button bid="disabled-2" disabled>Preferences</button>'
            '<input bid="hidden-3" type="hidden" aria-label="Preferences">'
        )

        controls = extract_semantic_controls(html)
        decision = propose_action("Open preferences", html)

        self.assertEqual([control.bid for control in controls], ["menu-1"])
        self.assertEqual(decision.action, 'click("menu-1")')

    def test_matches_an_exact_accessible_name_alias_before_partial_names(self) -> None:
        html = (
            '<button bid="settings-1" aria-label="Settings" title="Account settings">'
            "Open</button>"
            '<button bid="account-2" aria-label="Account settings">Open</button>'
        )

        decision = propose_action("Open settings", html)

        self.assertEqual(decision.action, 'click("settings-1")')

    def test_advances_explicit_multi_step_plan_against_fresh_observations(self) -> None:
        html = (
            '<input bid="name-7" aria-label="Full name">'
            '<select bid="priority-2" aria-label="Priority"></select>'
        )
        goal = "Fill full name with Ada then select priority as high"

        first = propose_plan_action(goal, html)
        second = propose_plan_action(goal, html, first.next_state)
        complete = propose_plan_action(goal, html, second.next_state)

        self.assertEqual(first.decision.action, 'fill("name-7", "Ada")')
        self.assertEqual(first.next_state, PlanState(step_index=1))
        self.assertEqual(second.decision.action, 'select_option("priority-2", "high")')
        self.assertTrue(second.completed)
        self.assertEqual(complete.decision.action, "noop()")

    def test_keeps_search_submission_in_the_same_plan_step(self) -> None:
        html = '<input bid="search-42" aria-label="Search docs">'
        goal = "Search for release notes then open settings page"

        first = propose_plan_action(goal, html)
        second = propose_plan_action(goal, html, first.next_state)

        self.assertEqual(first.decision.action, 'fill("search-42", "release notes")')
        self.assertEqual(first.next_state, PlanState(step_index=0, phase="filled"))
        self.assertEqual(second.decision.action, 'press("search-42", \'Enter\')')
        self.assertEqual(second.next_state, PlanState(step_index=1))

    def test_advances_a_workarena_knowledge_navigation_goal_without_guessing(self) -> None:
        search_html = '<input bid="search-42" aria-label="Search knowledge">'
        article_html = '<a bid="article-7" title="VPN access">VPN access</a>'
        goal = (
            'Navigate to a relevant article in the knowledge base by searching for: '
            '"VPN" and open the article: "VPN access"'
        )

        first = propose_plan_action(goal, search_html)
        second = propose_plan_action(goal, search_html, first.next_state)
        third = propose_plan_action(goal, article_html, second.next_state)

        self.assertEqual(first.decision.action, 'fill("search-42", "VPN")')
        self.assertEqual(second.decision.action, 'press("search-42", \'Enter\')')
        self.assertEqual(third.decision.action, 'click("article-7")')
        self.assertTrue(third.completed)

    def test_advances_a_workarena_menu_navigation_goal_without_guessing(self) -> None:
        goal = (
            'Navigate to the "Scheduled Jobs" module of the "System Scheduler" '
            "application."
        )
        all_menu_html = '<div bid="all-1" role="button" aria-label="All">All</div>'
        filter_html = '<input bid="filter-2" placeholder="Filter">'
        module_html = (
            '<div bid="module-3" role="button" aria-label="Scheduled Jobs">'
            "Scheduled Jobs</div>"
        )

        first = propose_plan_action(goal, all_menu_html)
        second = propose_plan_action(goal, filter_html, first.next_state)
        third = propose_plan_action(goal, module_html, second.next_state)

        self.assertEqual(first.decision.action, 'click("all-1")')
        self.assertEqual(second.decision.action, 'fill("filter-2", "System Scheduler")')
        self.assertEqual(third.decision.action, 'click("module-3")')
        self.assertTrue(third.completed)

    def test_fills_explicit_workarena_form_fields_without_submitting(self) -> None:
        goal = (
            'Create a new incident with a value of "VPN unavailable" for field '
            '"Short description" and a value of "high" for field "Priority".'
        )
        html = (
            '<input bid="description-1" aria-label="Short description">'
            '<input bid="priority-2" aria-label="Priority">'
            '<button bid="submit-3">Submit</button>'
        )

        first = propose_plan_action(goal, html)
        second = propose_plan_action(goal, html, first.next_state)
        complete = propose_plan_action(goal, html, second.next_state)

        self.assertEqual(first.decision.action, 'fill("description-1", "VPN unavailable")')
        self.assertEqual(second.decision.action, 'fill("priority-2", "high")')
        self.assertTrue(second.completed)
        self.assertEqual(complete.decision.action, "noop()")


if __name__ == "__main__":
    unittest.main()
