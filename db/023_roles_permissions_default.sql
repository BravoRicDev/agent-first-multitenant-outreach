INSERT INTO roles_permissions (role, resource, can_read, can_create, can_update, can_delete) VALUES
  ('collaboratore', 'companies', true, false, false, false),
  ('collaboratore', 'municipalities', true, false, false, false),
  ('collaboratore', 'direzione', false, false, false, false),
  ('collaboratore', 'settings', false, false, false, false),
  ('collaboratore', 'users', false, false, false, false),
  ('admin', 'companies', true, true, true, true),
  ('admin', 'municipalities', true, true, false, false),
  ('admin', 'direzione', true, true, true, false),
  ('admin', 'settings', true, false, true, false),
  ('admin', 'users', true, false, false, false)
ON CONFLICT (role, resource) DO NOTHING;
