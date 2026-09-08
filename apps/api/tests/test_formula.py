"""Формулы встроенных баз: разбор, вывод вида, вычисление, круги.

База здесь не нужна: разбор и вычисление — правила без ввода-вывода.
"""

from __future__ import annotations

import pytest

from tessera_api.domain.formula import (
    Context,
    FormulaGraph,
    FormulaParseError,
    Property,
    PropertyLink,
    compile_formula,
    evaluate,
    is_error_cell,
    parse_raw,
)

NUMBERS = {"Цена": "p1", "Кол-во": "p2"}
NUMBER_TYPES = {"p1": "number", "p2": "number"}


def build(source: str, names=None, types=None):
    return compile_formula(source, names or NUMBERS, types or NUMBER_TYPES)


def value(source: str, row: dict, names=None, types=None, properties=None):
    built = build(source, names, types)
    lookup = properties or {
        "p1": Property("p1", "number"),
        "p2": Property("p2", "number"),
    }
    return evaluate(built["ast"], row, Context(properties=lookup))


class TestParsing:
    def test_precedence_follows_arithmetic(self) -> None:
        """Умножение связывает крепче сложения.

        Без таблицы силы связывания «1 + 2 * 3» считалось бы слева направо и
        давало девять — молча и в каждой строке таблицы.
        """
        assert value("1 + 2 * 3", {}) == 7

    def test_parentheses_win(self) -> None:
        assert value("(1 + 2) * 3", {}) == 9

    def test_property_becomes_identifier(self) -> None:
        """В дереве лежит идентификатор, а не имя колонки.

        Иначе переименование колонки ломало бы каждую формулу, которая на неё
        ссылается.
        """
        built = build('prop("Цена") + 1')
        assert built["dependencies"] == ["p1"]
        assert built["ast"]["args"][0] == {"t": "prop", "id": "p1"}

    def test_unknown_property_is_refused(self) -> None:
        with pytest.raises(FormulaParseError):
            build('prop("Нет такой")')

    def test_bare_name_hints_at_prop(self) -> None:
        """Голое имя — самая частая ошибка, и отказ подсказывает написание."""
        with pytest.raises(FormulaParseError) as failure:
            build("Цена + 1", {"Цена": "p1"}, {"p1": "number"})
        assert "prop(" in str(failure.value)

    def test_unterminated_string_is_refused(self) -> None:
        with pytest.raises(FormulaParseError):
            build('concat("незакрытая)')

    def test_deep_nesting_is_refused_not_crashed(self) -> None:
        """Глубокая вложенность отвечает отказом, а не переполнением стека."""
        with pytest.raises(FormulaParseError):
            parse_raw("(" * 400 + "1" + ")" * 400)

    def test_too_long_source_is_refused(self) -> None:
        with pytest.raises(FormulaParseError):
            parse_raw("1+" * 6000)


class TestTypes:
    def test_number_arithmetic_is_number(self) -> None:
        assert build('prop("Цена") * 2')["resultType"] == "number"

    def test_plus_with_string_is_concatenation(self) -> None:
        """«+» двузначен: строка среди доводов делает его склейкой.

        Вывод вида обязан совпадать с вычислением — иначе колонка сохраняется
        числовой, а считается строковой.
        """
        built = compile_formula('prop("Имя") + "!"', {"Имя": "s1"}, {"s1": "string"})
        assert built["resultType"] == "string"
        assert (
            value(
                'prop("Имя") + "!"',
                {"s1": "Тесс"},
                {"Имя": "s1"},
                {"s1": "string"},
                {"s1": Property("s1", "text")},
            )
            == "Тесс!"
        )

    def test_string_arithmetic_is_refused(self) -> None:
        with pytest.raises(FormulaParseError):
            compile_formula('prop("Имя") * 2', {"Имя": "s1"}, {"s1": "string"})

    def test_if_branches_must_agree(self) -> None:
        with pytest.raises(FormulaParseError):
            build('if(true, 1, "строка")')

    def test_unknown_function_is_refused(self) -> None:
        with pytest.raises(FormulaParseError):
            build("нетТакого(1)")

    def test_wrong_argument_count_is_refused(self) -> None:
        with pytest.raises(FormulaParseError):
            build("round()")


class TestEvaluation:
    def test_empty_cell_gives_empty_result(self) -> None:
        """Пустая ячейка не делает ошибку: колонка бывает незаполненной."""
        assert value('prop("Цена") * 2', {}) is None

    def test_division_by_zero_is_a_cell_not_a_crash(self) -> None:
        """Ошибка данных красит одну ячейку, а не роняет выдачу строк."""
        result = value('prop("Цена") / prop("Кол-во")', {"p1": 10, "p2": 0})
        assert is_error_cell(result)
        assert result.code == "DIV_BY_ZERO"

    def test_sum_treats_empty_as_zero(self) -> None:
        """Иначе одна пустая ячейка обнуляла бы сумму по строке."""
        assert value('sum(prop("Цена"), prop("Кол-во"))', {"p1": 2}) == 2

    def test_rounding_is_half_up(self) -> None:
        """Половина вверх, как в v1: у Python своё правило, и 2.5 давало бы 2."""
        assert value("round(2.5)", {}) == 3
        assert value("round(2.345, 2)", {}) == 2.35

    def test_binary_tail_is_trimmed(self) -> None:
        """0.1 + 0.2 показывается как 0.3, а не хвостом двоичной дроби."""
        assert value("0.1 + 0.2", {}) == 0.3

    def test_condition_picks_a_branch(self) -> None:
        assert value('if(prop("Цена") > 100, "дорого", "дёшево")', {"p1": 150}) == "дорого"
        assert value('if(prop("Цена") > 100, "дорого", "дёшево")', {"p1": 5}) == "дёшево"

    def test_comparison_with_empty_is_false(self) -> None:
        """Пустое ни больше, ни меньше — ответ «нет», как в v1."""
        assert value('prop("Цена") > 1', {}) is False

    def test_nested_formula_is_computed(self) -> None:
        """Формула поверх формулы считается, а не отдаёт пусто."""
        inner = build('prop("Цена") * 2')
        properties = {
            "p1": Property("p1", "number"),
            "p3": Property("p3", "formula", inner),
        }
        result = value(
            'prop("Итого") + 1',
            {"p1": 5},
            {"Итого": "p3"},
            {"p3": "number"},
            properties,
        )
        assert result == 11

    def test_broken_dependency_marks_the_dependent(self) -> None:
        """Ячейка показывает, что виновата не она, а та, на которую ссылается."""
        result = value('round(prop("Цена") / prop("Кол-во"))', {"p1": 1, "p2": 0})
        assert is_error_cell(result)
        assert result.code == "DEPENDENCY_ERROR"

    def test_date_shift_keeps_the_month_end(self) -> None:
        """31 января плюс месяц — конец февраля, а не мартовская дата."""
        result = value('dateAdd("2026-01-31T00:00:00Z", 1, "months")', {})
        assert result.startswith("2026-02-28")

    def test_date_difference_counts_days(self) -> None:
        assert (
            value('dateBetween("2026-01-01T00:00:00Z", "2026-01-11T00:00:00Z", "days")', {}) == 10
        )


class TestGraph:
    def test_cycle_through_a_neighbour_is_seen(self) -> None:
        """Круг ловится до сохранения: с ним таблица перестаёт открываться."""
        graph = FormulaGraph([PropertyLink("a", "formula", {"dependencies": ["b"]})])
        assert graph.cycle_with(PropertyLink("b", "formula", {"dependencies": ["a"]})) is not None

    def test_plain_chain_is_not_a_cycle(self) -> None:
        graph = FormulaGraph([PropertyLink("a", "formula", {"dependencies": ["x"]})])
        assert graph.cycle_with(PropertyLink("b", "formula", {"dependencies": ["a"]})) is None

    def test_order_puts_dependencies_first(self) -> None:
        graph = FormulaGraph(
            [
                PropertyLink("b", "formula", {"dependencies": ["a"]}),
                PropertyLink("a", "formula", {"dependencies": []}),
            ]
        )
        order = graph.order()
        assert order.index("a") < order.index("b")

    def test_affected_walks_the_chain(self) -> None:
        """Правка колонки пересчитывает и тех, кто зависит от зависящих."""
        graph = FormulaGraph(
            [
                PropertyLink("b", "formula", {"dependencies": ["a"]}),
                PropertyLink("c", "formula", {"dependencies": ["b"]}),
            ]
        )
        assert graph.affected(["a"]) == ["b", "c"]
