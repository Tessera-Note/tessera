"""Обратные ссылки.

Разбор содержимого проверяется без базы, пересчёт и выдача — на настоящей.
Выдача обязана фильтроваться по правам: обратная ссылка раскрывает название и
адрес страницы-источника, а источник может лежать в закрытой ветке.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import Backlink, Page, PageAccess, Space, Workspace
from tessera_api.services.backlinks import (
    BacklinkService,
    extract_internal_link_slugs,
    extract_page_mentions,
    extract_user_mentions,
    internal_page_segment,
    page_slug_id,
    unfold_mentions,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tests.conftest import needs_database
from tests.test_page_access import _world


def _mention(entity_id: str, entity_type: str = "page", label: str = "Цель") -> dict:
    return {
        "type": "mention",
        "attrs": {
            "id": entity_id,
            "entityType": entity_type,
            "entityId": entity_id,
            "label": label,
        },
    }


def _link(href: str, *, internal: bool = True) -> dict:
    return {
        "type": "text",
        "text": "ссылка",
        "marks": [{"type": "link", "attrs": {"href": href, "internal": internal}}],
    }


def _doc(*nodes: dict) -> dict:
    return {"type": "doc", "content": [{"type": "paragraph", "content": list(nodes)}]}


class TestSlugExtraction:
    @pytest.mark.parametrize(
        ("given", "expected"),
        [
            ("моя-страница-abc123", "abc123"),
            ("abc123", "abc123"),
            ("много-дефисов-в-названии-xyz", "xyz"),
            ("", None),
        ],
    )
    def test_last_segment_wins(self, given: str, expected: str | None) -> None:
        """Короткое имя это последний сегмент.

        Название страницы само содержит дефисы, и брать первый сегмент или
        делить пополам означало бы промахиваться на любом составном названии.
        """
        assert page_slug_id(given) == expected


class TestAddressParsing:
    @pytest.mark.parametrize(
        ("href", "expected"),
        [
            ("/s/general/p/название-abc", "название-abc"),
            ("https://host/p/abc", "abc"),
            ("/p/abc/", "abc"),
            ("https://host/blog/post", None),
            ("", None),
            ("/p/", None),
            ("не адрес вовсе", None),
        ],
    )
    def test_page_segment_is_taken_from_the_path(
        self, href: str, expected: str | None
    ) -> None:
        """Сегмент берётся после раздела `p`, где бы тот ни стоял.

        Раздел пространства перед ним необязателен, домен и протокол тоже.
        """
        assert internal_page_segment(href) == expected


class TestMentions:
    def test_page_mentions_are_collected(self) -> None:
        first, second = uuid.uuid4(), uuid.uuid4()
        found = extract_page_mentions(_doc(_mention(str(first)), _mention(str(second))))
        assert found == [first, second]

    def test_user_mentions_are_ignored(self) -> None:
        """Упоминание человека связи между страницами не создаёт."""
        assert extract_page_mentions(_doc(_mention(str(uuid.uuid4()), "user"))) == []

    def test_repeated_mention_counts_once(self) -> None:
        one = uuid.uuid4()
        assert extract_page_mentions(_doc(_mention(str(one)), _mention(str(one)))) == [one]

    def test_broken_identifier_does_not_break_the_page(self) -> None:
        """Один сломанный узел не должен ронять сохранение страницы.

        Содержимое приходит от редактора, и узел с непригодным
        идентификатором пропускается молча.
        """
        good = uuid.uuid4()
        assert extract_page_mentions(_doc(_mention("не-uuid"), _mention(str(good)))) == [good]

    def test_deeply_nested_mention_is_found(self) -> None:
        one = uuid.uuid4()
        deep = {
            "type": "doc",
            "content": [
                {
                    "type": "bulletList",
                    "content": [
                        {
                            "type": "listItem",
                            "content": [{"type": "paragraph", "content": [_mention(str(one))]}],
                        }
                    ],
                }
            ],
        }
        assert extract_page_mentions(deep) == [one]

    @pytest.mark.parametrize("content", [None, {}, [], "строка", {"type": "doc"}])
    def test_odd_content_yields_nothing(self, content) -> None:  # noqa: ANN001
        assert extract_page_mentions(content) == []


class TestUserMentions:
    """Упоминания людей.

    Разбор общий с упоминаниями страниц, и вид сущности — единственное, что их
    различает. Перепутать их значит либо завести обратную ссылку на человека,
    либо уведомить страницу.
    """

    def test_user_mentions_are_collected(self) -> None:
        first, second = uuid.uuid4(), uuid.uuid4()
        content = _doc(
            _mention(str(first), "user"),
            _mention(str(second), "user"),
        )
        assert extract_user_mentions(content) == [first, second]

    def test_page_mentions_are_not_user_mentions(self) -> None:
        page_id, user_id = uuid.uuid4(), uuid.uuid4()
        content = _doc(_mention(str(page_id), "page"), _mention(str(user_id), "user"))

        assert extract_user_mentions(content) == [user_id]
        assert extract_page_mentions(content) == [page_id]

    def test_repeated_user_mention_counts_once(self) -> None:
        one = uuid.uuid4()
        content = _doc(_mention(str(one), "user"), _mention(str(one), "user"))
        assert extract_user_mentions(content) == [one]

    def test_broken_identifier_is_skipped(self) -> None:
        good = uuid.uuid4()
        content = _doc(_mention("не-uuid", "user"), _mention(str(good), "user"))
        assert extract_user_mentions(content) == [good]


class TestInternalLinks:
    @pytest.mark.parametrize(
        ("href", "expected"),
        [
            ("https://tessera.local/s/general/p/страница-abc123", ["abc123"]),
            ("/p/abc123", ["abc123"]),
            ("http://host/p/my-page-xyz/", ["xyz"]),
            ("https://example.com/blog/post", []),
            ("/s/general/p/abc123", ["abc123"]),
            ("/p/отчёт-за-год-zz9", ["zz9"]),
            ("https://host/s/общее/p/название-qq1?ref=x#top", ["qq1"]),
        ],
    )
    def test_only_page_addresses_are_taken(self, href: str, expected: list[str]) -> None:
        """Адрес разбирается как адрес, а не сопоставляется с образцом.

        Выражение из v1 допускает в сегменте только латиницу с цифрами, и
        ссылка на страницу с русским названием под него не подходит: связь не
        создаётся, хотя ссылка работает и выглядит обычной.
        """
        assert extract_internal_link_slugs(_doc(_link(href))) == expected

    def test_external_link_is_ignored_even_if_it_looks_internal(self) -> None:
        """Пометка `internal` обязательна.

        Внешний адрес, случайно совпавший по виду с внутренним, связи не
        создаёт: иначе ссылка на чужой сайт вида `/p/xxx` завела бы связь.
        """
        assert extract_internal_link_slugs(_doc(_link("/p/abc123", internal=False))) == []

    def test_repeated_link_counts_once(self) -> None:
        content = _doc(_link("/p/abc123"), _link("/p/abc123"))
        assert extract_internal_link_slugs(content) == ["abc123"]


@needs_database
class TestRebuild:
    async def test_mention_creates_a_link(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        source, target = world["root"], world["child"]
        source.content = _doc(_mention(str(target.id)))
        await session.flush()

        written = await BacklinkService(session).rebuild(source)
        assert written == 1

        found = (
            await session.execute(
                select(Backlink.target_page_id).where(Backlink.source_page_id == source.id)
            )
        ).scalars().all()
        assert list(found) == [target.id]

    async def test_internal_link_creates_a_link(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        source, target = world["root"], world["child"]
        source.content = _doc(_link(f"/p/название-{target.slug_id}"))
        await session.flush()

        assert await BacklinkService(session).rebuild(source) == 1

    async def test_self_reference_is_not_recorded(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ссылка страницы на себя связи не создаёт.

        Иначе каждая страница со ссылкой на собственный раздел показывала бы
        саму себя в списке ссылающихся.
        """
        world = await _world(session, workspace, owner, space)
        source = world["root"]
        source.content = _doc(_mention(str(source.id)))
        await session.flush()

        assert await BacklinkService(session).rebuild(source) == 0

    async def test_link_to_a_missing_page_is_dropped(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        source = world["root"]
        source.content = _doc(_mention(str(uuid.uuid4())))
        await session.flush()

        assert await BacklinkService(session).rebuild(source) == 0

    async def test_stale_link_is_removed_on_the_next_pass(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Пересчёт полный: убранная из текста ссылка исчезает и из связей."""
        world = await _world(session, workspace, owner, space)
        source, target = world["root"], world["child"]
        service = BacklinkService(session)

        source.content = _doc(_mention(str(target.id)))
        await session.flush()
        await service.rebuild(source)

        source.content = _doc()
        await session.flush()
        await service.rebuild(source)

        left = (
            await session.execute(
                select(func.count())
                .select_from(Backlink)
                .where(Backlink.source_page_id == source.id)
            )
        ).scalar_one()
        assert left == 0

    async def test_second_pass_does_not_duplicate(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        source, target = world["root"], world["child"]
        source.content = _doc(_mention(str(target.id)))
        await session.flush()

        service = BacklinkService(session)
        await service.rebuild(source)
        await service.rebuild(source)

        count = (
            await session.execute(
                select(func.count())
                .select_from(Backlink)
                .where(Backlink.source_page_id == source.id)
            )
        ).scalar_one()
        assert count == 1

    async def test_page_from_another_workspace_is_not_linked(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Цель сверяется с рабочим пространством.

        Идентификатор приходит из содержимого, то есть от человека. Ссылка на
        страницу чужого пространства завела бы связь через границу, и та
        страница появилась бы в списке ссылающихся у чужих людей.
        """
        world = await _world(session, workspace, owner, space)

        other_workspace = uuid.uuid4()
        await session.execute(
            insert(Workspace).values(id=other_workspace, name=f"Чужое {uuid.uuid4().hex[:6]}")
        )
        other_space = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=other_space,
                name="Чужое пространство",
                slug=uuid.uuid4().hex[:8],
                workspace_id=other_workspace,
                creator_id=owner.id,
            )
        )
        foreign_page = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=foreign_page,
                slug_id=uuid.uuid4().hex[:10],
                title="Чужая страница",
                creator_id=owner.id,
                space_id=other_space,
                workspace_id=other_workspace,
            )
        )
        await session.flush()

        source = world["root"]
        source.content = _doc(_mention(str(foreign_page)))
        await session.flush()

        assert await BacklinkService(session).rebuild(source) == 0
        written = (
            await session.execute(
                select(func.count())
                .select_from(Backlink)
                .where(Backlink.source_page_id == source.id)
            )
        ).scalar_one()
        assert written == 0


@needs_database
class TestIncoming:
    async def _linked(self, session, workspace, owner, space):
        world = await _world(session, workspace, owner, space)
        source, target = world["root"], world["grandchild"]
        source.content = _doc(_mention(str(target.id)))
        await session.flush()
        await BacklinkService(session).rebuild(source)
        return world, source, target

    async def test_incoming_lists_the_source(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        _, source, target = await self._linked(session, workspace, owner, space)
        listed = await BacklinkService(session).incoming(target, owner.id)
        assert [one["id"] for one in listed] == [source.id]

    async def test_closed_source_is_hidden(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Источник в закрытой ветке не показывается тому, кому она закрыта.

        Обратная ссылка раскрывает название и адрес источника — это утечка
        содержимого не меньшая, чем сама страница.
        """
        world, source, target = await self._linked(session, workspace, owner, space)
        await session.execute(
            insert(PageAccess).values(
                id=uuid.uuid4(),
                page_id=source.id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.flush()

        listed = await BacklinkService(session).incoming(target, world["outsider_id"])
        assert listed == []

    async def test_page_without_incoming_links_returns_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        assert await BacklinkService(session).incoming(world["child"], owner.id) == []


class TestUnfold:
    """Разворот упоминания в текст.

    Проверяется то, ради чего разворот заведён: узел упоминания несёт
    идентификатор цели и переживает её удаление насовсем. Связь в таблице
    уходит вместе со строкой страницы, а узел остаётся в теле каждого
    источника и виден там перечёркнутой ссылкой в никуда.
    """

    def test_mention_of_the_target_becomes_its_label(self) -> None:
        target = uuid.uuid4()
        made = unfold_mentions(_doc(_mention(str(target), label="Регламент")), {target})
        assert made == _doc({"type": "text", "text": "Регламент"})

    def test_a_mention_of_another_page_is_left_alone(self) -> None:
        other = uuid.uuid4()
        assert unfold_mentions(_doc(_mention(str(other))), {uuid.uuid4()}) is None

    def test_a_person_is_left_alone(self) -> None:
        """Вид сущности различается: удаление страницы имени не касается."""
        same = uuid.uuid4()
        content = _doc(_mention(str(same), entity_type="user"))
        assert unfold_mentions(content, {same}) is None

    def test_a_mention_without_a_label_goes_away(self) -> None:
        """Пустой текстовый узел схема редактора не допускает."""
        target = uuid.uuid4()
        made = unfold_mentions(_doc(_mention(str(target), label="")), {target})
        assert made == {"type": "doc", "content": [{"type": "paragraph", "content": []}]}

    def test_a_broken_identifier_is_left_alone(self) -> None:
        content = _doc(
            {"type": "mention", "attrs": {"entityType": "page", "entityId": "не идентификатор"}}
        )
        assert unfold_mentions(content, {uuid.uuid4()}) is None

    def test_nothing_to_unfold_gives_nothing(self) -> None:
        """Пусто значит «переписывать страницу не надо»."""
        plain = _doc({"type": "text", "text": "Просто текст"})
        assert unfold_mentions(plain, {uuid.uuid4()}) is None
        assert unfold_mentions(None, {uuid.uuid4()}) is None
        assert unfold_mentions(_doc(_mention(str(uuid.uuid4()))), set()) is None

    def test_the_unfolded_text_joins_its_neighbours(self) -> None:
        """Два текстовых узла подряд с одинаковыми пометками — один узел."""
        target = uuid.uuid4()
        content = _doc(
            {"type": "text", "text": "см. "},
            _mention(str(target), label="Регламент"),
            {"type": "text", "text": " и далее"},
        )
        made = unfold_mentions(content, {target})
        assert made == _doc({"type": "text", "text": "см. Регламент и далее"})

    def test_text_with_other_marks_is_not_joined(self) -> None:
        target = uuid.uuid4()
        bold = {"type": "text", "text": "жирно", "marks": [{"type": "bold"}]}
        made = unfold_mentions(_doc(bold, _mention(str(target), label="Цель")), {target})
        assert made == _doc(bold, {"type": "text", "text": "Цель"})

    def test_a_mention_deep_inside_is_reached(self) -> None:
        """Упоминание бывает в ячейке таблицы, а не только в абзаце."""
        target = uuid.uuid4()
        content = {
            "type": "doc",
            "content": [
                {
                    "type": "table",
                    "content": [
                        {
                            "type": "tableRow",
                            "content": [
                                {
                                    "type": "tableCell",
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "content": [_mention(str(target), label="Цель")],
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ],
        }
        made = unfold_mentions(content, {target})
        assert made is not None
        assert extract_page_mentions(made) == []
        assert "Цель" in str(made)

    def test_the_original_is_not_changed(self) -> None:
        """Вызывающий сравнивает прежнее с новым, и правка на месте это ломает."""
        target = uuid.uuid4()
        content = _doc(_mention(str(target), label="Цель"))
        before = str(content)
        unfold_mentions(content, {target})
        assert str(content) == before

    def test_several_targets_at_once(self) -> None:
        first, second = uuid.uuid4(), uuid.uuid4()
        content = _doc(
            _mention(str(first), label="Первая"),
            _mention(str(second), label="Вторая"),
        )
        made = unfold_mentions(content, {first, second})
        assert made == _doc({"type": "text", "text": "ПерваяВторая"})


@needs_database
class TestUnfoldOnDelete:
    """Разворот упоминаний в базе, по всем источникам пространства."""

    async def test_the_source_page_is_rewritten(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        source, target = world["root"], world["child"]
        source.content = _doc(_mention(str(target.id), label="Ребёнок"))
        source.text_content = ""
        # Двоичное состояние есть у всякой страницы, которую открывали в
        # редакторе. Оставленное, оно вернуло бы упоминание назад.
        source.ydoc = b"\x00\x01"
        await session.flush()

        assert await BacklinkService(session).unfold(
            workspace_id=workspace.id, targets=[target.id]
        ) == 1

        await session.refresh(source)
        assert extract_page_mentions(source.content) == []
        assert "Ребёнок" in (source.text_content or "")
        assert source.ydoc is None

    async def test_the_deleted_page_itself_is_not_rewritten(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Строка цели всё равно уходит, и лишняя запись в неё ни к чему."""
        world = await _world(session, workspace, owner, space)
        target = world["child"]
        target.content = _doc(_mention(str(target.id), label="Сама себя"))
        await session.flush()

        assert await BacklinkService(session).unfold(
            workspace_id=workspace.id, targets=[target.id]
        ) == 0

    async def test_a_page_in_the_trash_is_rewritten_too(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Её ещё вернут, и вернуть её полагается без мёртвой ссылки."""
        world = await _world(session, workspace, owner, space)
        source, target = world["root"], world["child"]
        source.content = _doc(_mention(str(target.id), label="Ребёнок"))
        source.deleted_at = datetime.now(UTC)
        await session.flush()

        assert await BacklinkService(session).unfold(
            workspace_id=workspace.id, targets=[target.id]
        ) == 1

    async def test_another_workspace_is_not_touched(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отбор идёт по рабочему пространству, а не по одному идентификатору."""
        world = await _world(session, workspace, owner, space)
        source, target = world["root"], world["child"]
        source.content = _doc(_mention(str(target.id), label="Ребёнок"))
        await session.flush()

        assert await BacklinkService(session).unfold(
            workspace_id=uuid.uuid4(), targets=[target.id]
        ) == 0

    async def test_no_targets_is_no_work(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        assert await BacklinkService(session).unfold(workspace_id=workspace.id, targets=[]) == 0
