table "ai_chat_messages" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "chat_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "user_id" {
    null = true
    type = uuid
  }
  column "role" {
    null = false
    type = character_varying
  }
  column "content" {
    null = true
    type = text
  }
  column "tool_calls" {
    null = true
    type = jsonb
  }
  column "metadata" {
    null = true
    type = jsonb
  }
  column "tsv" {
    null = true
    type = tsvector
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "ai_chat_messages_chat_id_fkey" {
    columns     = [column.chat_id]
    ref_columns = [table.ai_chats.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "ai_chat_messages_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "ai_chat_messages_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_ai_chat_messages_chat_id" {
    columns = [column.chat_id, column.id]
  }
  index "idx_ai_chat_messages_tsv" {
    columns = [column.tsv]
    type    = GIN
  }
}
table "ai_chats" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "creator_id" {
    null = false
    type = uuid
  }
  column "title" {
    null = true
    type = character_varying
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "ai_chats_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "ai_chats_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_ai_chats_workspace_creator" {
    columns = [column.workspace_id, column.creator_id, column.id]
  }
}
table "api_keys" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "name" {
    null = true
    type = text
  }
  column "creator_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "expires_at" {
    null = true
    type = timestamptz
  }
  column "last_used_at" {
    null = true
    type = timestamptz
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "api_keys_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "api_keys_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_api_keys_workspace_id" {
    columns = [column.workspace_id]
  }
}
table "attachments" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "file_name" {
    null = false
    type = character_varying
  }
  column "file_path" {
    null = false
    type = character_varying
  }
  column "file_size" {
    null = true
    type = bigint
  }
  column "file_ext" {
    null = false
    type = character_varying
  }
  column "mime_type" {
    null = true
    type = character_varying
  }
  column "type" {
    null = true
    type = character_varying
  }
  column "creator_id" {
    null = false
    type = uuid
  }
  column "page_id" {
    null = true
    type = uuid
  }
  column "space_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "text_content" {
    null = true
    type = text
  }
  column "tsv" {
    null = true
    type = tsvector
  }
  column "ai_chat_id" {
    null = true
    type = uuid
  }
  column "index_status" {
    null    = false
    type    = character_varying(20)
    default = "not_processed"
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "attachments_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "attachments_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "attachments_tsv_idx" {
    columns = [column.tsv]
    type    = GIN
  }
  index "idx_attachments_ai_chat_id" {
    columns = [column.ai_chat_id]
  }
  index "idx_attachments_page_id" {
    columns = [column.page_id]
  }
  index "idx_attachments_space_id" {
    columns = [column.space_id]
  }
  index "idx_attachments_workspace_id" {
    columns = [column.workspace_id]
  }
}
table "audit" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "actor_id" {
    null = true
    type = uuid
  }
  column "actor_type" {
    null    = false
    type    = character_varying
    default = "user"
  }
  column "event" {
    null = false
    type = character_varying
  }
  column "resource_type" {
    null = false
    type = character_varying
  }
  column "resource_id" {
    null = true
    type = uuid
  }
  column "space_id" {
    null = true
    type = uuid
  }
  column "changes" {
    null = true
    type = jsonb
  }
  column "metadata" {
    null = true
    type = jsonb
  }
  column "ip_address" {
    null = true
    type = inet
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "audit_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_audit_workspace_id" {
    on {
      column = column.workspace_id
    }
    on {
      desc   = true
      column = column.id
    }
  }
}
table "auth_accounts" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "provider_user_id" {
    null = false
    type = character_varying
  }
  column "auth_provider_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "match_claim_value" {
    null = true
    type = character_varying
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "auth_accounts_auth_provider_id_fkey" {
    columns     = [column.auth_provider_id]
    ref_columns = [table.auth_providers.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "auth_accounts_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "auth_accounts_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_auth_accounts_provider_user_id" {
    columns = [column.provider_user_id, column.auth_provider_id]
  }
  index "idx_auth_accounts_provider_match_claim" {
    columns = [column.auth_provider_id, column.match_claim_value]
  }
  unique "auth_accounts_user_id_auth_provider_id_unique" {
    columns = [column.user_id, column.auth_provider_id]
  }
}
table "auth_providers" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "name" {
    null = false
    type = character_varying
  }
  column "type" {
    null = false
    type = text
  }
  column "saml_url" {
    null = true
    type = character_varying
  }
  column "saml_certificate" {
    null = true
    type = character_varying
  }
  column "oidc_issuer" {
    null = true
    type = character_varying
  }
  column "oidc_client_id" {
    null = true
    type = character_varying
  }
  column "oidc_client_secret" {
    null = true
    type = character_varying
  }
  column "allow_signup" {
    null    = false
    type    = boolean
    default = false
  }
  column "is_enabled" {
    null    = false
    type    = boolean
    default = false
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "group_sync" {
    null    = false
    type    = boolean
    default = false
  }
  column "ldap_url" {
    null = true
    type = character_varying
  }
  column "ldap_bind_dn" {
    null = true
    type = character_varying
  }
  column "ldap_bind_password" {
    null = true
    type = character_varying
  }
  column "ldap_base_dn" {
    null = true
    type = character_varying
  }
  column "ldap_user_search_filter" {
    null = true
    type = character_varying
  }
  column "ldap_user_attributes" {
    null    = true
    type    = jsonb
    default = "{}"
  }
  column "ldap_tls_enabled" {
    null    = true
    type    = boolean
    default = false
  }
  column "ldap_tls_ca_cert" {
    null = true
    type = text
  }
  column "ldap_config" {
    null    = true
    type    = jsonb
    default = "{}"
  }
  column "settings" {
    null    = true
    type    = jsonb
    default = "{}"
  }
  column "group_claim_name" {
    null = true
    type = character_varying
  }
  column "match_claim_name" {
    null = true
    type = character_varying
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "auth_providers_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "auth_providers_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_auth_providers_workspace_id" {
    columns = [column.workspace_id]
  }
}
table "backlinks" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "source_page_id" {
    null = false
    type = uuid
  }
  column "target_page_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "backlinks_source_page_id_fkey" {
    columns     = [column.source_page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "backlinks_target_page_id_fkey" {
    columns     = [column.target_page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "backlinks_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_backlinks_target_page_id" {
    columns = [column.target_page_id]
  }
  unique "backlinks_source_page_id_target_page_id_unique" {
    columns = [column.source_page_id, column.target_page_id]
  }
}
table "base_jsonb_quarantine" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "table_name" {
    null = false
    type = character_varying
  }
  column "column_name" {
    null = false
    type = character_varying
  }
  column "row_id" {
    null = false
    type = text
  }
  column "original_value" {
    null = true
    type = text
  }
  column "quarantined_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
}
table "base_properties" {
  schema = schema.public
  column "id" {
    null = false
    type = character_varying
  }
  column "page_id" {
    null = false
    type = uuid
  }
  column "name" {
    null = false
    type = character_varying
  }
  column "type" {
    null = false
    type = character_varying
  }
  column "position" {
    null = false
    type = character_varying
  }
  column "type_options" {
    null = true
    type = jsonb
  }
  column "is_primary" {
    null    = false
    type    = boolean
    default = false
  }
  column "schema_version" {
    null    = false
    type    = integer
    default = 1
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.page_id, column.id]
  }
  foreign_key "base_properties_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "base_properties_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "base_properties_page_name_alive_unique" {
    unique = true
    where  = "(deleted_at IS NULL)"
    on {
      column = column.page_id
    }
    on {
      expr = "lower(TRIM(BOTH FROM name))"
    }
  }
  index "idx_base_properties_page_id" {
    columns = [column.page_id]
  }
  check "base_properties_type_options_is_object" {
    expr = "((type_options IS NULL) OR (jsonb_typeof(type_options) = 'object'::text))"
  }
}
table "base_rows" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "page_id" {
    null = false
    type = uuid
  }
  column "cells" {
    null    = false
    type    = jsonb
    default = "{}"
  }
  column "position" {
    null = false
    type = character_varying
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "last_updated_by_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "base_rows_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "base_rows_last_updated_by_id_fkey" {
    columns     = [column.last_updated_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "base_rows_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "base_rows_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_base_rows_page_created" {
    where = "(deleted_at IS NULL)"
    on {
      column = column.page_id
    }
    on {
      desc   = true
      column = column.created_at
    }
  }
  index "idx_base_rows_page_updated" {
    where = "(deleted_at IS NULL)"
    on {
      column = column.page_id
    }
    on {
      desc   = true
      column = column.updated_at
    }
  }
  check "base_rows_cells_is_object" {
    expr = "(jsonb_typeof(cells) = 'object'::text)"
  }
}
table "base_views" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "page_id" {
    null = false
    type = uuid
  }
  column "name" {
    null = false
    type = character_varying
  }
  column "type" {
    null    = false
    type    = character_varying
    default = "table"
  }
  column "position" {
    null = false
    type = character_varying
  }
  column "config" {
    null    = false
    type    = jsonb
    default = "{}"
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "base_views_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "base_views_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "base_views_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_base_views_page_id" {
    columns = [column.page_id]
  }
  check "base_views_config_is_object" {
    expr = "(jsonb_typeof(config) = 'object'::text)"
  }
}
table "billing" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "stripe_subscription_id" {
    null = false
    type = character_varying
  }
  column "stripe_customer_id" {
    null = true
    type = character_varying
  }
  column "status" {
    null = false
    type = character_varying
  }
  column "quantity" {
    null = true
    type = bigint
  }
  column "amount" {
    null = true
    type = bigint
  }
  column "interval" {
    null = true
    type = character_varying
  }
  column "currency" {
    null = true
    type = character_varying
  }
  column "metadata" {
    null = true
    type = jsonb
  }
  column "stripe_price_id" {
    null = true
    type = character_varying
  }
  column "stripe_item_id" {
    null = true
    type = character_varying
  }
  column "stripe_product_id" {
    null = true
    type = character_varying
  }
  column "period_start_at" {
    null = false
    type = timestamptz
  }
  column "period_end_at" {
    null = true
    type = timestamptz
  }
  column "cancel_at_period_end" {
    null = true
    type = boolean
  }
  column "cancel_at" {
    null = true
    type = timestamptz
  }
  column "canceled_at" {
    null = true
    type = timestamptz
  }
  column "ended_at" {
    null = true
    type = timestamptz
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "billing_scheme" {
    null = true
    type = character_varying
  }
  column "tiered_up_to" {
    null = true
    type = character_varying
  }
  column "tiered_flat_amount" {
    null = true
    type = bigint
  }
  column "tiered_unit_amount" {
    null = true
    type = bigint
  }
  column "plan_name" {
    null = true
    type = character_varying
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "billing_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  unique "billing_stripe_subscription_id_unique" {
    columns = [column.stripe_subscription_id]
  }
}
table "comments" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "content" {
    null = true
    type = jsonb
  }
  column "selection" {
    null = true
    type = character_varying
  }
  column "type" {
    null = true
    type = character_varying
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "page_id" {
    null = false
    type = uuid
  }
  column "parent_comment_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "resolved_at" {
    null = true
    type = timestamptz
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "edited_at" {
    null = true
    type = timestamptz
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "last_edited_by_id" {
    null = true
    type = uuid
  }
  column "resolved_by_id" {
    null = true
    type = uuid
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "space_id" {
    null = false
    type = uuid
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "comments_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "comments_last_edited_by_id_fkey" {
    columns     = [column.last_edited_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "comments_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "comments_parent_comment_id_fkey" {
    columns     = [column.parent_comment_id]
    ref_columns = [table.comments.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "comments_resolved_by_id_fkey" {
    columns     = [column.resolved_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "comments_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "comments_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  index "idx_comments_page_id" {
    columns = [column.page_id]
  }
  index "idx_comments_parent_comment_id" {
    columns = [column.parent_comment_id]
  }
}
table "favorites" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "page_id" {
    null = true
    type = uuid
  }
  column "space_id" {
    null = true
    type = uuid
  }
  column "template_id" {
    null = true
    type = uuid
  }
  column "type" {
    null = false
    type = character_varying
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "favorites_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "favorites_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "favorites_template_id_fkey" {
    columns     = [column.template_id]
    ref_columns = [table.templates.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "favorites_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "favorites_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_favorites_user_page" {
    unique  = true
    columns = [column.user_id, column.page_id]
    where   = "(page_id IS NOT NULL)"
  }
  index "idx_favorites_user_space" {
    unique  = true
    columns = [column.user_id, column.space_id]
    where   = "(space_id IS NOT NULL)"
  }
  index "idx_favorites_user_template" {
    unique  = true
    columns = [column.user_id, column.template_id]
    where   = "(template_id IS NOT NULL)"
  }
  index "idx_favorites_user_workspace_type" {
    columns = [column.user_id, column.workspace_id, column.type]
  }
}
table "file_tasks" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "type" {
    null = true
    type = character_varying
  }
  column "source" {
    null = true
    type = character_varying
  }
  column "status" {
    null = true
    type = character_varying
  }
  column "file_name" {
    null = false
    type = character_varying
  }
  column "file_path" {
    null = false
    type = character_varying
  }
  column "file_size" {
    null = true
    type = bigint
  }
  column "file_ext" {
    null = true
    type = character_varying
  }
  column "error_message" {
    null = true
    type = character_varying
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "space_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "page_id" {
    null = true
    type = uuid
  }
  column "metadata" {
    null = true
    type = jsonb
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "file_tasks_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "file_tasks_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "file_tasks_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "file_tasks_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_file_tasks_page_export" {
    columns = [column.page_id, column.workspace_id]
    where   = "(((type)::text = 'export'::text) AND (deleted_at IS NULL))"
  }
}
table "group_users" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "group_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "group_users_group_id_fkey" {
    columns     = [column.group_id]
    ref_columns = [table.groups.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "group_users_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_group_users_user_id" {
    columns = [column.user_id]
  }
  unique "group_users_group_id_user_id_unique" {
    columns = [column.group_id, column.user_id]
  }
}
table "groups" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "name" {
    null = false
    type = character_varying
  }
  column "description" {
    null = true
    type = text
  }
  column "is_default" {
    null = false
    type = boolean
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "scim_external_id" {
    null = true
    type = text
  }
  column "is_external" {
    null    = false
    type    = boolean
    default = false
  }
  column "directory_source" {
    null = true
    type = character_varying(10)
  }
  column "directory_provider_id" {
    null = true
    type = uuid
  }
  column "directory_key" {
    null = true
    type = text
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "groups_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "groups_directory_provider_id_fkey" {
    columns     = [column.directory_provider_id]
    ref_columns = [table.auth_providers.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "groups_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_groups_directory_key_scim" {
    unique  = true
    columns = [column.workspace_id, column.directory_key]
    where   = "(((directory_source)::text = 'scim'::text) AND (directory_key IS NOT NULL))"
  }
  index "idx_groups_directory_key_sso" {
    unique  = true
    columns = [column.workspace_id, column.directory_provider_id, column.directory_key]
    where   = "(((directory_source)::text = 'sso'::text) AND (directory_key IS NOT NULL))"
  }
  index "idx_groups_name_lower_workspace" {
    unique = true
    on {
      expr = "lower((name)::text)"
    }
    on {
      column = column.workspace_id
    }
  }
  index "idx_groups_workspace_id" {
    columns = [column.workspace_id]
  }
  index "idx_groups_workspace_scim_external_id" {
    unique  = true
    columns = [column.workspace_id, column.scim_external_id]
    where   = "(scim_external_id IS NOT NULL)"
  }
  check "groups_directory_source_check" {
    expr = "((directory_source IS NULL) OR ((directory_source)::text = ANY ((ARRAY['scim'::character varying, 'sso'::character varying])::text[])))"
  }
  unique "groups_name_workspace_id_unique" {
    columns = [column.name, column.workspace_id]
  }
}
table "kysely_migration" {
  schema = schema.public
  column "name" {
    null = false
    type = character_varying(255)
  }
  column "timestamp" {
    null = false
    type = character_varying(255)
  }
  primary_key {
    columns = [column.name]
  }
}
table "kysely_migration_lock" {
  schema = schema.public
  column "id" {
    null = false
    type = character_varying(255)
  }
  column "is_locked" {
    null    = false
    type    = integer
    default = 0
  }
  primary_key {
    columns = [column.id]
  }
}
table "labels" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "name" {
    null = false
    type = character_varying
  }
  column "type" {
    null    = false
    type    = character_varying
    default = "page"
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "labels_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "labels_workspace_id_type_name_unique" {
    unique  = true
    columns = [column.workspace_id, column.type, column.name]
  }
}
table "notifications" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "type" {
    null = false
    type = text
  }
  column "actor_id" {
    null = true
    type = uuid
  }
  column "page_id" {
    null = true
    type = uuid
  }
  column "space_id" {
    null = true
    type = uuid
  }
  column "comment_id" {
    null = true
    type = uuid
  }
  column "data" {
    null = true
    type = jsonb
  }
  column "read_at" {
    null = true
    type = timestamptz
  }
  column "emailed_at" {
    null = true
    type = timestamptz
  }
  column "archived_at" {
    null = true
    type = timestamptz
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "page_verification_id" {
    null = true
    type = uuid
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "notifications_actor_id_fkey" {
    columns     = [column.actor_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "notifications_comment_id_fkey" {
    columns     = [column.comment_id]
    ref_columns = [table.comments.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "notifications_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "notifications_page_verification_id_fkey" {
    columns     = [column.page_verification_id]
    ref_columns = [table.page_verifications.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "notifications_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "notifications_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "notifications_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_notifications_comment_id" {
    columns = [column.comment_id]
  }
  index "idx_notifications_page_id" {
    columns = [column.page_id]
  }
  index "idx_notifications_space_id" {
    columns = [column.space_id]
  }
  index "idx_notifications_user_id" {
    on {
      column = column.user_id
    }
    on {
      desc   = true
      column = column.id
    }
  }
  index "idx_notifications_user_unread" {
    columns = [column.user_id]
    where   = "(read_at IS NULL)"
  }
}
table "page_access" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "page_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "space_id" {
    null = false
    type = uuid
  }
  column "access_level" {
    null = false
    type = character_varying
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "page_access_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "page_access_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_access_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_access_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_page_access_space" {
    columns = [column.space_id]
  }
  unique "page_access_page_id_key" {
    columns = [column.page_id]
  }
}
table "page_embeddings" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "page_id" {
    null = false
    type = uuid
  }
  column "space_id" {
    null = false
    type = uuid
  }
  column "model_name" {
    null = false
    type = character_varying
  }
  column "model_dimensions" {
    null = false
    type = integer
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "attachment_id" {
    null = true
    type = uuid
  }
  column "embedding" {
    null = false
    type = sql("vector(1536)")
  }
  column "chunk_index" {
    null    = false
    type    = integer
    default = 0
  }
  column "chunk_start" {
    null    = false
    type    = integer
    default = 0
  }
  column "chunk_length" {
    null    = false
    type    = integer
    default = 0
  }
  column "metadata" {
    null    = false
    type    = jsonb
    default = "{}"
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "driver" {
    null = true
    type = character_varying
  }
  column "base_url" {
    null = true
    type = character_varying
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "page_embeddings_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_embeddings_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "page_embeddings_embedding_idx" {
    type = "hnsw"
    on {
      column = column.embedding
      ops    = "vector_cosine_ops"
    }
  }
  index "page_embeddings_identity_idx" {
    columns = [column.workspace_id, column.driver, column.model_name, column.base_url]
  }
  index "page_embeddings_page_id_idx" {
    columns = [column.page_id]
  }
  index "page_embeddings_scope_idx" {
    columns = [column.workspace_id, column.space_id]
  }
  index "page_embeddings_space_id_idx" {
    columns = [column.space_id]
  }
}
table "page_history" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "page_id" {
    null = false
    type = uuid
  }
  column "slug_id" {
    null = true
    type = character_varying
  }
  column "title" {
    null = true
    type = character_varying
  }
  column "content" {
    null = true
    type = jsonb
  }
  column "slug" {
    null = true
    type = character_varying
  }
  column "icon" {
    null = true
    type = character_varying
  }
  column "cover_photo" {
    null = true
    type = character_varying
  }
  column "version" {
    null = true
    type = integer
  }
  column "last_updated_by_id" {
    null = true
    type = uuid
  }
  column "space_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "contributor_ids" {
    null    = true
    type    = sql("uuid[]")
    default = "{}"
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "page_history_last_updated_by_id_fkey" {
    columns     = [column.last_updated_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "page_history_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_history_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_history_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_page_history_page_created" {
    on {
      column = column.page_id
    }
    on {
      desc   = true
      column = column.created_at
    }
  }
}
table "page_labels" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "page_id" {
    null = false
    type = uuid
  }
  column "label_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "page_labels_label_id_fkey" {
    columns     = [column.label_id]
    ref_columns = [table.labels.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_labels_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "page_labels_label_id_idx" {
    columns = [column.label_id]
  }
  unique "page_labels_page_id_label_id_unique" {
    columns = [column.page_id, column.label_id]
  }
}
table "page_permissions" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "page_access_id" {
    null = false
    type = uuid
  }
  column "user_id" {
    null = true
    type = uuid
  }
  column "group_id" {
    null = true
    type = uuid
  }
  column "role" {
    null = false
    type = character_varying
  }
  column "added_by_id" {
    null = true
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "page_permissions_added_by_id_fkey" {
    columns     = [column.added_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "page_permissions_group_id_fkey" {
    columns     = [column.group_id]
    ref_columns = [table.groups.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_permissions_page_access_id_fkey" {
    columns     = [column.page_access_id]
    ref_columns = [table.page_access.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_permissions_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_page_permissions_group" {
    columns = [column.group_id]
  }
  index "idx_page_permissions_user" {
    columns = [column.user_id]
  }
  check "allow_either_user_id_or_group_id_check" {
    expr = "(((user_id IS NOT NULL) AND (group_id IS NULL)) OR ((user_id IS NULL) AND (group_id IS NOT NULL)))"
  }
  unique "page_access_group_unique" {
    columns = [column.page_access_id, column.group_id]
  }
  unique "page_access_user_unique" {
    columns = [column.page_access_id, column.user_id]
  }
}
table "page_transclusion_references" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "reference_page_id" {
    null = false
    type = uuid
  }
  column "source_page_id" {
    null = false
    type = uuid
  }
  column "transclusion_id" {
    null = false
    type = character_varying
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "page_transclusion_references_reference_page_id_fkey" {
    columns     = [column.reference_page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_transclusion_references_source_page_id_fkey" {
    columns     = [column.source_page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_transclusion_references_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_page_transclusion_references_source" {
    columns = [column.source_page_id, column.transclusion_id]
  }
  index "idx_page_transclusion_references_workspace" {
    columns = [column.workspace_id]
  }
  unique "page_transclusion_references_unique" {
    columns = [column.reference_page_id, column.source_page_id, column.transclusion_id]
  }
}
table "page_transclusions" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "page_id" {
    null = false
    type = uuid
  }
  column "transclusion_id" {
    null = false
    type = character_varying
  }
  column "content" {
    null = false
    type = jsonb
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "page_transclusions_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_transclusions_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_page_transclusions_workspace" {
    columns = [column.workspace_id]
  }
  unique "page_transclusions_page_transclusion_unique" {
    columns = [column.page_id, column.transclusion_id]
  }
}
table "page_verifications" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "page_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "space_id" {
    null = false
    type = uuid
  }
  column "type" {
    null    = false
    type    = character_varying
    default = "expiring"
  }
  column "status" {
    null = true
    type = character_varying
  }
  column "mode" {
    null = true
    type = character_varying
  }
  column "period_amount" {
    null = true
    type = integer
  }
  column "period_unit" {
    null = true
    type = character_varying
  }
  column "verified_at" {
    null = true
    type = timestamptz
  }
  column "verified_by_id" {
    null = true
    type = uuid
  }
  column "expires_at" {
    null = true
    type = timestamptz
  }
  column "requested_at" {
    null = true
    type = timestamptz
  }
  column "requested_by_id" {
    null = true
    type = uuid
  }
  column "rejected_at" {
    null = true
    type = timestamptz
  }
  column "rejected_by_id" {
    null = true
    type = uuid
  }
  column "rejection_comment" {
    null = true
    type = text
  }
  column "data" {
    null = true
    type = jsonb
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "page_verifications_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "page_verifications_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_verifications_rejected_by_id_fkey" {
    columns     = [column.rejected_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "page_verifications_requested_by_id_fkey" {
    columns     = [column.requested_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "page_verifications_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_verifications_verified_by_id_fkey" {
    columns     = [column.verified_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "page_verifications_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_page_verifications_expires_at" {
    columns = [column.expires_at]
    where   = "(expires_at IS NOT NULL)"
  }
  index "idx_page_verifications_space_id" {
    columns = [column.space_id]
  }
  index "idx_page_verifications_workspace_id_id" {
    on {
      column = column.workspace_id
    }
    on {
      desc   = true
      column = column.id
    }
  }
  unique "page_verifications_page_id_key" {
    columns = [column.page_id]
  }
}
table "page_verifiers" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "page_verification_id" {
    null = false
    type = uuid
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "is_primary" {
    null    = false
    type    = boolean
    default = false
  }
  column "added_by_id" {
    null = true
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "page_verifiers_added_by_id_fkey" {
    columns     = [column.added_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "page_verifiers_page_verification_id_fkey" {
    columns     = [column.page_verification_id]
    ref_columns = [table.page_verifications.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "page_verifiers_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_page_verifiers_user_id" {
    columns = [column.user_id]
  }
  unique "page_verifiers_verification_user_unique" {
    columns = [column.page_verification_id, column.user_id]
  }
}
table "pages" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "slug_id" {
    null = false
    type = character_varying
  }
  column "title" {
    null = true
    type = character_varying
  }
  column "icon" {
    null = true
    type = character_varying
  }
  column "cover_photo" {
    null = true
    type = character_varying
  }
  column "position" {
    null = true
    type = character_varying
  }
  column "content" {
    null = true
    type = jsonb
  }
  column "ydoc" {
    null = true
    type = bytea
  }
  column "text_content" {
    null = true
    type = text
  }
  column "tsv" {
    null = true
    type = tsvector
  }
  column "parent_page_id" {
    null = true
    type = uuid
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "last_updated_by_id" {
    null = true
    type = uuid
  }
  column "deleted_by_id" {
    null = true
    type = uuid
  }
  column "space_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "is_locked" {
    null    = false
    type    = boolean
    default = false
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "contributor_ids" {
    null    = true
    type    = sql("uuid[]")
    default = "{}"
  }
  column "is_base" {
    null    = false
    type    = boolean
    default = false
  }
  column "base_schema_version" {
    null    = false
    type    = integer
    default = 0
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "pages_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "pages_deleted_by_id_fkey" {
    columns     = [column.deleted_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "pages_last_updated_by_id_fkey" {
    columns     = [column.last_updated_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "pages_parent_page_id_fkey" {
    columns     = [column.parent_page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "pages_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "pages_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_pages_creator_id" {
    columns = [column.creator_id]
  }
  index "idx_pages_parent_page_id" {
    columns = [column.parent_page_id]
    where   = "(deleted_at IS NULL)"
  }
  index "idx_pages_space_deleted" {
    where = "(deleted_at IS NOT NULL)"
    on {
      column = column.space_id
    }
    on {
      desc   = true
      column = column.deleted_at
    }
  }
  index "idx_pages_space_updated" {
    where = "(deleted_at IS NULL)"
    on {
      column = column.space_id
    }
    on {
      desc   = true
      column = column.updated_at
    }
  }
  index "idx_pages_workspace_id" {
    columns = [column.workspace_id]
  }
  index "pages_tsv_idx" {
    columns = [column.tsv]
    type    = GIN
  }
  index "pages_workspace_id_id_idx" {
    columns = [column.workspace_id, column.id]
  }
  unique "pages_slug_id_unique" {
    columns = [column.slug_id]
  }
}
table "scim_tokens" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "name" {
    null = false
    type = character_varying
  }
  column "token_hash" {
    null = false
    type = character_varying
  }
  column "token_last_four" {
    null = false
    type = character_varying(4)
  }
  column "last_used_at" {
    null = true
    type = timestamptz
  }
  column "is_enabled" {
    null    = false
    type    = boolean
    default = true
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "scim_tokens_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "scim_tokens_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_scim_tokens_token_hash" {
    columns = [column.token_hash]
  }
  index "idx_scim_tokens_workspace_id" {
    columns = [column.workspace_id]
  }
}
table "shares" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "key" {
    null = false
    type = character_varying
  }
  column "page_id" {
    null = true
    type = uuid
  }
  column "include_sub_pages" {
    null    = true
    type    = boolean
    default = false
  }
  column "search_indexing" {
    null    = true
    type    = boolean
    default = false
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "space_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "shares_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "shares_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "shares_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "shares_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_shares_page_id" {
    columns = [column.page_id]
  }
  unique "shares_key_workspace_id_unique" {
    columns = [column.key, column.workspace_id]
  }
}
table "space_members" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "user_id" {
    null = true
    type = uuid
  }
  column "group_id" {
    null = true
    type = uuid
  }
  column "space_id" {
    null = false
    type = uuid
  }
  column "role" {
    null = false
    type = character_varying
  }
  column "added_by_id" {
    null = true
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "space_members_added_by_id_fkey" {
    columns     = [column.added_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "space_members_group_id_fkey" {
    columns     = [column.group_id]
    ref_columns = [table.groups.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "space_members_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "space_members_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_space_members_group_id" {
    columns = [column.group_id]
  }
  index "idx_space_members_user_id" {
    columns = [column.user_id]
  }
  check "allow_either_user_id_or_group_id_check" {
    expr = "(((user_id IS NOT NULL) AND (group_id IS NULL)) OR ((user_id IS NULL) AND (group_id IS NOT NULL)))"
  }
  unique "space_members_space_id_group_id_unique" {
    columns = [column.space_id, column.group_id]
  }
  unique "space_members_space_id_user_id_unique" {
    columns = [column.space_id, column.user_id]
  }
}
table "spaces" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "name" {
    null = true
    type = character_varying
  }
  column "description" {
    null = true
    type = text
  }
  column "slug" {
    null = false
    type = character_varying
  }
  column "logo" {
    null = true
    type = character_varying
  }
  column "visibility" {
    null    = false
    type    = character_varying
    default = "private"
  }
  column "default_role" {
    null    = false
    type    = character_varying
    default = "writer"
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "settings" {
    null = true
    type = jsonb
  }
  column "is_personal" {
    null    = false
    type    = boolean
    default = false
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "spaces_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "spaces_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_spaces_slug_lower_workspace" {
    unique = true
    on {
      expr = "lower((slug)::text)"
    }
    on {
      column = column.workspace_id
    }
    # Только живые пространства. Удаление здесь мягкое, и без этого условия имя
    # удалённого оставалось бы занятым навсегда: проверка в коде смотрит на
    # признак удаления, а ограничение — нет, и попытка занять освободившееся имя
    # падала пятисотым вместо внятного отказа.
    where = "(deleted_at IS NULL)"
  }
  index "idx_spaces_workspace_id" {
    columns = [column.workspace_id]
  }
  index "spaces_personal_creator_unique" {
    unique  = true
    columns = [column.creator_id]
    where   = "((is_personal = true) AND (deleted_at IS NULL))"
  }
  index "spaces_slug_workspace_id_unique" {
    unique = true
    columns = [column.slug, column.workspace_id]
    # Индексом, а не ограничением: ограничение уникальности нельзя ограничить
    # условием, а условие здесь и есть весь смысл — см. соседний индекс.
    where = "(deleted_at IS NULL)"
  }
}
table "templates" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "title" {
    null = true
    type = character_varying
  }
  column "description" {
    null = true
    type = text
  }
  column "content" {
    null = true
    type = jsonb
  }
  column "ydoc" {
    null = true
    type = bytea
  }
  column "icon" {
    null = true
    type = character_varying
  }
  column "space_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "creator_id" {
    null = true
    type = uuid
  }
  column "last_updated_by_id" {
    null = true
    type = uuid
  }
  column "collaborator_ids" {
    null = true
    type = sql("uuid[]")
  }
  column "text_content" {
    null = true
    type = text
  }
  column "tsv" {
    null = true
    type = tsvector
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "templates_creator_id_fkey" {
    columns     = [column.creator_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "templates_last_updated_by_id_fkey" {
    columns     = [column.last_updated_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "templates_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "templates_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_templates_space_id" {
    columns = [column.space_id]
  }
  index "idx_templates_workspace_id" {
    columns = [column.workspace_id]
  }
  index "templates_tsv_idx" {
    columns = [column.tsv]
    type    = GIN
  }
}
table "user_mfa" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "method" {
    null    = false
    type    = character_varying
    default = "totp"
  }
  column "secret" {
    null = true
    type = text
  }
  column "is_enabled" {
    null    = true
    type    = boolean
    default = false
  }
  column "backup_codes" {
    null = true
    type = sql("text[]")
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "user_mfa_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "user_mfa_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  unique "user_mfa_user_id_unique" {
    columns = [column.user_id]
  }
}
table "user_sessions" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "device_name" {
    null = true
    type = character_varying
  }
  column "user_agent" {
    null = true
    type = text
  }
  column "ip_address" {
    null = true
    type = inet
  }
  column "geo_location" {
    null = true
    type = character_varying
  }
  column "last_active_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "expires_at" {
    null = false
    type = timestamptz
  }
  column "metadata" {
    null = true
    type = jsonb
  }
  column "revoked_at" {
    null = true
    type = timestamptz
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "user_sessions_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "user_sessions_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_user_sessions_active" {
    where = "(revoked_at IS NULL)"
    on {
      column = column.user_id
    }
    on {
      column = column.workspace_id
    }
    on {
      desc   = true
      column = column.last_active_at
    }
  }
  index "idx_user_sessions_revoked" {
    columns = [column.expires_at]
    where   = "(revoked_at IS NOT NULL)"
  }
  index "idx_user_sessions_user_workspace" {
    columns = [column.user_id, column.workspace_id]
  }
}
table "user_tokens" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "token" {
    null = false
    type = character_varying
  }
  column "type" {
    null = false
    type = character_varying
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = true
    type = uuid
  }
  column "expires_at" {
    null = true
    type = timestamptz
  }
  column "used_at" {
    null = true
    type = timestamptz
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "user_tokens_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "user_tokens_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
}
table "users" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "name" {
    null = true
    type = character_varying
  }
  column "email" {
    null = false
    type = character_varying
  }
  column "email_verified_at" {
    null = true
    type = timestamptz
  }
  column "password" {
    null = true
    type = character_varying
  }
  column "avatar_url" {
    null = true
    type = character_varying
  }
  column "role" {
    null = true
    type = character_varying
  }
  column "invited_by_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = true
    type = uuid
  }
  column "locale" {
    null = true
    type = character_varying
  }
  column "timezone" {
    null = true
    type = character_varying
  }
  column "settings" {
    null = true
    type = jsonb
  }
  column "last_active_at" {
    null = true
    type = timestamptz
  }
  column "last_login_at" {
    null = true
    type = timestamptz
  }
  column "deactivated_at" {
    null = true
    type = timestamptz
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "has_generated_password" {
    null    = false
    type    = boolean
    default = false
  }
  column "scim_external_id" {
    null = true
    type = text
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "users_invited_by_id_fkey" {
    columns     = [column.invited_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "users_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_users_workspace_deleted" {
    columns = [column.workspace_id, column.deleted_at]
  }
  index "idx_users_workspace_scim_external_id" {
    unique  = true
    columns = [column.workspace_id, column.scim_external_id]
    where   = "(scim_external_id IS NOT NULL)"
  }
  unique "users_email_workspace_id_unique" {
    columns = [column.email, column.workspace_id]
  }
}
table "watchers" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "page_id" {
    null = true
    type = uuid
  }
  column "space_id" {
    null = false
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "type" {
    null = false
    type = text
  }
  column "added_by_id" {
    null = true
    type = uuid
  }
  column "muted_at" {
    null = true
    type = timestamptz
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "watchers_added_by_id_fkey" {
    columns     = [column.added_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  foreign_key "watchers_page_id_fkey" {
    columns     = [column.page_id]
    ref_columns = [table.pages.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "watchers_space_id_fkey" {
    columns     = [column.space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "watchers_user_id_fkey" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "watchers_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_watchers_page_id" {
    columns = [column.page_id]
  }
  index "idx_watchers_space_id" {
    columns = [column.space_id]
  }
  index "idx_watchers_user_page" {
    unique  = true
    columns = [column.user_id, column.page_id]
    where   = "(page_id IS NOT NULL)"
  }
  index "idx_watchers_user_space" {
    unique  = true
    columns = [column.user_id, column.space_id]
    where   = "(page_id IS NULL)"
  }
  index "idx_watchers_user_workspace" {
    columns = [column.user_id, column.workspace_id]
  }
}
table "workspace_ai_settings" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "driver" {
    null = true
    type = character_varying
  }
  column "base_url" {
    null = true
    type = character_varying
  }
  column "api_key_encrypted" {
    null = true
    type = text
  }
  column "chat_model" {
    null = true
    type = character_varying
  }
  column "completion_model" {
    null = true
    type = character_varying
  }
  column "embedding_base_url" {
    null = true
    type = character_varying
  }
  column "embedding_api_key_encrypted" {
    null = true
    type = text
  }
  column "embedding_model" {
    null = true
    type = character_varying
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "web_search_driver" {
    null = true
    type = character_varying
  }
  column "web_search_base_url" {
    null = true
    type = character_varying
  }
  column "web_search_api_key_encrypted" {
    null = true
    type = text
  }
  column "embedding_driver" {
    null = true
    type = character_varying
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "workspace_ai_settings_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  unique "workspace_ai_settings_workspace_id_key" {
    columns = [column.workspace_id]
  }
}
table "workspace_invitations" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "email" {
    null = true
    type = character_varying
  }
  column "role" {
    null = false
    type = character_varying
  }
  column "token" {
    null = false
    type = character_varying
  }
  column "group_ids" {
    null = true
    type = sql("uuid[]")
  }
  column "invited_by_id" {
    null = true
    type = uuid
  }
  column "workspace_id" {
    null = false
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "workspace_invitations_invited_by_id_fkey" {
    columns     = [column.invited_by_id]
    ref_columns = [table.users.column.id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "workspace_invitations_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  index "idx_workspace_invitations_workspace_id" {
    columns = [column.workspace_id]
  }
  unique "invitations_email_workspace_id_unique" {
    columns = [column.email, column.workspace_id]
  }
}
table "workspaces" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_uuid_v7()")
  }
  column "name" {
    null = true
    type = character_varying
  }
  column "description" {
    null = true
    type = character_varying
  }
  column "logo" {
    null = true
    type = character_varying
  }
  column "hostname" {
    null = true
    type = character_varying
  }
  column "custom_domain" {
    null = true
    type = character_varying
  }
  column "settings" {
    null = true
    type = jsonb
  }
  column "default_role" {
    null    = false
    type    = character_varying
    default = "member"
  }
  column "email_domains" {
    null    = true
    type    = sql("character varying[]")
    default = "{}"
  }
  column "default_space_id" {
    null = true
    type = uuid
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  column "stripe_customer_id" {
    null = true
    type = character_varying
  }
  column "status" {
    null = true
    type = character_varying
  }
  column "plan" {
    null = true
    type = character_varying
  }
  column "billing_email" {
    null = true
    type = character_varying
  }
  column "trial_end_at" {
    null = true
    type = timestamptz
  }
  column "enforce_sso" {
    null    = false
    type    = boolean
    default = false
  }
  column "enforce_mfa" {
    null    = true
    type    = boolean
    default = false
  }
  column "audit_retention_days" {
    null = true
    type = bigint
  }
  column "trash_retention_days" {
    null = true
    type = bigint
  }
  column "is_scim_enabled" {
    null    = false
    type    = boolean
    default = false
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "workspaces_default_space_id_fkey" {
    columns     = [column.default_space_id]
    ref_columns = [table.spaces.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  index "idx_workspaces_created_at" {
    columns = [column.created_at]
  }
  index "idx_workspaces_hostname_lower" {
    unique = true
    on {
      expr = "lower((hostname)::text)"
    }
  }
  unique "workspaces_custom_domain_unique" {
    columns = [column.custom_domain]
  }
  unique "workspaces_hostname_unique" {
    columns = [column.hostname]
  }
  unique "workspaces_stripe_customer_id_unique" {
    columns = [column.stripe_customer_id]
  }
}
schema "public" {
  comment = "standard public schema"
}
