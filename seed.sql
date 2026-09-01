-- Minimal seed data so the bot can run without hardcoded user-facing strings.
-- You should edit these rows as you like.

INSERT OR REPLACE INTO messages (message_tag, section, message_text) VALUES
  ('system_message_missing', 'system', '[missing message: {tag}]'),

  ('onboarding_intro', 'onboarding', 'Hi! Let’s set you up.'),
  ('onboarding_ask_name', 'onboarding', 'What is your name?'),
  ('onboarding_ask_email', 'onboarding', 'What is your work email?'),
  ('onboarding_ask_location', 'onboarding', 'What is your location (city, country) or timezone (e.g. Asia/Yerevan)?'),
  ('onboarding_complete', 'onboarding', 'Done, {name}! You can now use the menu.'),

  ('menu_main', 'menu', 'Main menu:'),
  ('menu_profile', 'menu', 'My Profile'),
  ('menu_projects', 'menu', 'My Projects'),
  ('menu_shop', 'menu', 'Shop'),

  ('profile_card', 'profile', 'Name: {name}\nEmail: {email}\nSparks: {sparks}\nStreak: {streak}\nTimezone: {timezone}\nReminder: {reminder_time}'),

  ('projects_list_header', 'projects', 'Your projects:'),
  ('projects_empty', 'projects', 'No projects found for {email}.'),

  ('shop_list_header', 'shop', 'Shop helpers:'),
  ('shop_insufficient_sparks', 'shop', 'Not enough sparks. Price: {price}, your balance: {balance}.'),
  ('shop_purchase_success', 'shop', 'Purchased {helper}. New balance: {balance}.'),
  ('shop_sell_success', 'shop', 'Sold {helper}. New balance: {balance}.');

INSERT OR REPLACE INTO parameters (parameter_key, parameter_value, parameter_description) VALUES
  ('default_timezone', 'UTC', 'Used if profile timezone missing'),
  ('default_reminder_time', '09:00', 'Used if profile reminder_time missing'),
  ('pagination_size', '5', 'Default page size');

-- Example projects/helpers (edit or delete)
INSERT OR REPLACE INTO projects (project_tag, project_name, project_owner_email, project_status) VALUES
  ('HOSQ', 'HOSQ Core', 'owner@hosq.co', 'in progress');

INSERT OR REPLACE INTO helpers (name, price, image_link, description) VALUES
  ('Coffee Buddy', 5, '', 'A small boost for a productive day');

