import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsUUID,
  IsArray,
  IsObject,
  IsNumber,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * `@IsOptional()` пропускает и `undefined`, и `null`. Для полей, которые
 * ложатся в NOT NULL столбцы, этого мало: явный `null` доходил до базы и
 * возвращался как 500 вместо 400. Этот декоратор пропускает проверку только
 * для отсутствующего поля, а `null` отправляет в общий валидатор типа.
 */
const IsOptionalNotNull = () => ValidateIf((_, value) => value !== undefined);

export class CreateBaseDto {
  @IsString()
  @IsOptional()
  name?: string;

  // description в DTO не объявлен намеренно: в таблице pages такой колонки
  // нет, писать значение некуда. Поле принималось и молча терялось.
  @IsString()
  @IsOptional()
  icon?: string;

  @IsUUID()
  @IsOptional()
  pageId?: string;

  @IsUUID()
  @IsOptional()
  parentPageId?: string;

  @IsUUID()
  @IsOptional()
  spaceId?: string;

  @IsString()
  @IsOptional()
  template?: string;
}

export class UpdateBaseDto {
  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  icon?: string;
}

export class PageIdDto {
  @IsUUID()
  @IsNotEmpty()
  pageId: string;
}

export class ExpandPagesDto {
  /**
   * Клиент батчит запросы ячеек-ссылок в один вызов на микрозадачу. Предел
   * ограничивает размер батча: без него один запрос мог бы попросить разбор
   * произвольного числа страниц.
   */
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  pageIds: string[];
}

export class SpaceIdDto {
  @IsUUID()
  @IsNotEmpty()
  spaceId: string;
}

export class ConvertBaseDto {
  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsOptional()
  template?: string;
}

export class CreatePropertyDto {
  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  type: string;

  @IsObject()
  @IsOptional()
  typeOptions?: any;
}

export class UpdatePropertyDto {
  @IsString()
  @IsNotEmpty()
  propertyId: string;

  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsOptionalNotNull()
  name?: string;

  @IsString()
  @IsOptionalNotNull()
  type?: string;

  @IsObject()
  @IsOptional()
  typeOptions?: any;
}

export class DeletePropertyDto {
  @IsString()
  @IsNotEmpty()
  propertyId: string;

  @IsUUID()
  @IsNotEmpty()
  pageId: string;
}

export class ReorderPropertyDto {
  @IsString()
  @IsNotEmpty()
  propertyId: string;

  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  position: string;
}

export class CreateRowDto {
  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsObject()
  @IsOptional()
  cells?: Record<string, any>;

  @IsString()
  @IsOptional()
  position?: string;

  /**
   * Идентификатор запроса возвращается в событии сокета. Клиент по нему
   * отбрасывает эхо собственной мутации, иначе локальное обновление кеша
   * применилось бы дважды.
   */
  @IsString()
  @IsOptional()
  requestId?: string;
}

export class RowInfoDto {
  @IsUUID()
  @IsNotEmpty()
  rowId: string;

  @IsUUID()
  @IsNotEmpty()
  pageId: string;
}

export class UpdateRowDto {
  @IsUUID()
  @IsNotEmpty()
  rowId: string;

  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsObject()
  @IsNotEmpty()
  cells: Record<string, any>;

  @IsString()
  @IsOptional()
  position?: string;

  /**
   * Идентификатор запроса возвращается в событии сокета. Клиент по нему
   * отбрасывает эхо собственной мутации, иначе локальное обновление кеша
   * применилось бы дважды.
   */
  @IsString()
  @IsOptional()
  requestId?: string;
}

export class DeleteRowDto {
  @IsUUID()
  @IsNotEmpty()
  rowId: string;

  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  /**
   * Идентификатор запроса возвращается в событии сокета. Клиент по нему
   * отбрасывает эхо собственной мутации, иначе локальное обновление кеша
   * применилось бы дважды.
   */
  @IsString()
  @IsOptional()
  requestId?: string;
}

export class DeleteRowsDto {
  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  rowIds: string[];

  /**
   * Идентификатор запроса возвращается в событии сокета. Клиент по нему
   * отбрасывает эхо собственной мутации, иначе локальное обновление кеша
   * применилось бы дважды.
   */
  @IsString()
  @IsOptional()
  requestId?: string;
}

export class ReorderRowDto {
  @IsUUID()
  @IsNotEmpty()
  rowId: string;

  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  position: string;

  /**
   * Идентификатор запроса возвращается в событии сокета. Клиент по нему
   * отбрасывает эхо собственной мутации, иначе локальное обновление кеша
   * применилось бы дважды.
   */
  @IsString()
  @IsOptional()
  requestId?: string;
}

export class ListRowsDto {
  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsOptional()
  cursor?: string;

  /**
   * Потолок держит выборку в границах одного запроса. Клиент просит 100
   * (`base-row-query.ts`), для большего объема вводится курсорный проход,
   * а не подъем потолка.
   */
  @IsNumber()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;

  @IsObject()
  @IsOptional()
  filter?: any;

  /**
   * Сортировка на сервере не реализована: порядок всегда по position.
   * Поле оставлено в контракте, но непустой список отвергается явной ошибкой,
   * иначе клиент считал бы, что сортировка применена, а получал бы исходный
   * порядок. Клиент досортировывает загруженные страницы сам.
   */
  @IsArray()
  @ArrayMaxSize(0, {
    message: 'Сортировка на стороне сервера не поддерживается',
  })
  @IsOptional()
  sorts?: any[];
}

export class CreateViewDto {
  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsObject()
  @IsOptional()
  config?: any;
}

export class UpdateViewDto {
  @IsUUID()
  @IsNotEmpty()
  viewId: string;

  @IsUUID()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsOptionalNotNull()
  name?: string;

  @IsString()
  @IsOptionalNotNull()
  type?: string;

  @IsObject()
  @IsOptional()
  config?: any;

  @IsString()
  @IsOptionalNotNull()
  position?: string;
}

export class DeleteViewDto {
  @IsUUID()
  @IsNotEmpty()
  viewId: string;

  @IsUUID()
  @IsNotEmpty()
  pageId: string;
}
