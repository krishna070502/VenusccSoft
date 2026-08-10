-- Venus Chicken Centers — PostgreSQL schema
-- Generated from app/models.py. `python manage.py init-db` does this for you;
-- this file is here for DBAs and for provisioning by hand.

BEGIN;

CREATE TABLE branches (
	id SERIAL NOT NULL, 
	code VARCHAR(16) NOT NULL, 
	name VARCHAR(160) NOT NULL, 
	address TEXT, 
	is_active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX ix_branches_code ON branches (code);

CREATE TABLE settings (
	key VARCHAR(64) NOT NULL, 
	value VARCHAR(255) NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (key)
);

CREATE TABLE users (
	id SERIAL NOT NULL, 
	username VARCHAR(64) NOT NULL, 
	name VARCHAR(160) NOT NULL, 
	password_hash VARCHAR(255) NOT NULL, 
	role VARCHAR(20) NOT NULL, 
	is_active BOOLEAN NOT NULL, 
	last_login_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_users_role CHECK (role IN ('admin','supervisor'))
);
CREATE UNIQUE INDEX ix_users_username ON users (username);

CREATE TABLE activity_log (
	id SERIAL NOT NULL, 
	at TIMESTAMP WITH TIME ZONE NOT NULL, 
	user_id INTEGER, 
	user_name VARCHAR(160), 
	role VARCHAR(20), 
	branch_code VARCHAR(16), 
	action VARCHAR(80) NOT NULL, 
	detail TEXT, 
	ip_address VARCHAR(64), 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX ix_activity_log_at ON activity_log (at);
CREATE INDEX ix_activity_log_action ON activity_log (action);

CREATE TABLE customers (
	id VARCHAR(32) NOT NULL, 
	branch_id INTEGER NOT NULL, 
	code VARCHAR(16) NOT NULL, 
	name VARCHAR(160) NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	contact_person VARCHAR(160), 
	phone VARCHAR(32), 
	address TEXT, 
	price_mode VARCHAR(8) NOT NULL, 
	less_skin NUMERIC(12, 2) NOT NULL, 
	less_skinless NUMERIC(12, 2) NOT NULL, 
	less_liver NUMERIC(12, 2) NOT NULL, 
	rate_skin NUMERIC(12, 2) NOT NULL, 
	rate_skinless NUMERIC(12, 2) NOT NULL, 
	rate_liver NUMERIC(12, 2) NOT NULL, 
	opening_balance NUMERIC(14, 2) NOT NULL, 
	is_active BOOLEAN NOT NULL, 
	created_by_id INTEGER, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_customer_branch_code UNIQUE (branch_id, code), 
	CONSTRAINT ck_customer_kind CHECK (kind IN ('hotel','hostel')), 
	CONSTRAINT ck_customer_price_mode CHECK (price_mode IN ('less','fixed')), 
	FOREIGN KEY(branch_id) REFERENCES branches (id) ON DELETE CASCADE, 
	FOREIGN KEY(created_by_id) REFERENCES users (id)
);
CREATE INDEX ix_customers_branch_id ON customers (branch_id);
CREATE INDEX ix_customer_branch_active ON customers (branch_id, is_active);

CREATE TABLE daily_entries (
	id VARCHAR(32) NOT NULL, 
	branch_id INTEGER NOT NULL, 
	category VARCHAR(16) NOT NULL, 
	business_date DATE NOT NULL, 
	entered_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	open_birds INTEGER NOT NULL, 
	open_weight_g INTEGER NOT NULL, 
	open_meat_g INTEGER NOT NULL, 
	open_rate NUMERIC(12, 2) NOT NULL, 
	rate_skin NUMERIC(12, 2) NOT NULL, 
	rate_skinless NUMERIC(12, 2) NOT NULL, 
	rate_liver NUMERIC(12, 2) NOT NULL, 
	rate_live NUMERIC(12, 2) NOT NULL, 
	live_sold_count INTEGER NOT NULL, 
	live_sold_weight_g INTEGER NOT NULL, 
	cutting_charges NUMERIC(12, 2) NOT NULL, 
	mortality_count INTEGER NOT NULL, 
	mortality_weight_g INTEGER NOT NULL, 
	damage_meat_g INTEGER NOT NULL, 
	dressed_count INTEGER NOT NULL, 
	dressed_weight_g INTEGER NOT NULL, 
	actual_meat_g INTEGER NOT NULL, 
	skin_sold_g INTEGER NOT NULL, 
	skinless_sold_g INTEGER NOT NULL, 
	liver_sold_g INTEGER NOT NULL, 
	close_birds INTEGER NOT NULL, 
	close_weight_g INTEGER NOT NULL, 
	close_meat_g INTEGER NOT NULL, 
	notes TEXT, 
	explanation TEXT, 
	status VARCHAR(16) NOT NULL, 
	created_by_id INTEGER NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	updated_by_id INTEGER, 
	updated_at TIMESTAMP WITH TIME ZONE, 
	reviewed_by_id INTEGER, 
	reviewed_at TIMESTAMP WITH TIME ZONE, 
	reject_reason TEXT, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_entry_branch_category_date UNIQUE (branch_id, category, business_date), 
	CONSTRAINT ck_entry_category CHECK (category IN ('broiler','parents')), 
	CONSTRAINT ck_entry_status CHECK (status IN ('draft','pending','approved','rejected')), 
	FOREIGN KEY(branch_id) REFERENCES branches (id) ON DELETE CASCADE, 
	FOREIGN KEY(created_by_id) REFERENCES users (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id), 
	FOREIGN KEY(reviewed_by_id) REFERENCES users (id)
);
CREATE INDEX ix_entry_branch_date ON daily_entries (branch_id, business_date);
CREATE INDEX ix_entry_status ON daily_entries (status);

CREATE TABLE overheads (
	id VARCHAR(32) NOT NULL, 
	branch_id INTEGER NOT NULL, 
	period_month VARCHAR(7) NOT NULL, 
	category VARCHAR(40) NOT NULL, 
	amount NUMERIC(14, 2) NOT NULL, 
	note TEXT, 
	status VARCHAR(16) NOT NULL, 
	created_by_id INTEGER NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	reviewed_by_id INTEGER, 
	reviewed_at TIMESTAMP WITH TIME ZONE, 
	reject_reason TEXT, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_overhead_status CHECK (status IN ('pending','approved','rejected')), 
	FOREIGN KEY(branch_id) REFERENCES branches (id) ON DELETE CASCADE, 
	FOREIGN KEY(created_by_id) REFERENCES users (id), 
	FOREIGN KEY(reviewed_by_id) REFERENCES users (id)
);
CREATE INDEX ix_overhead_branch_month ON overheads (branch_id, period_month);
CREATE INDEX ix_overheads_branch_id ON overheads (branch_id);
CREATE INDEX ix_overheads_period_month ON overheads (period_month);

CREATE TABLE user_branches (
	user_id INTEGER NOT NULL, 
	branch_id INTEGER NOT NULL, 
	PRIMARY KEY (user_id, branch_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(branch_id) REFERENCES branches (id) ON DELETE CASCADE
);

CREATE TABLE workers (
	id VARCHAR(32) NOT NULL, 
	branch_id INTEGER NOT NULL, 
	name VARCHAR(160) NOT NULL, 
	role VARCHAR(32) NOT NULL, 
	day_wage NUMERIC(12, 2) NOT NULL, 
	phone VARCHAR(32), 
	joined_on DATE, 
	is_active BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(branch_id) REFERENCES branches (id) ON DELETE CASCADE
);
CREATE INDEX ix_workers_branch_id ON workers (branch_id);

CREATE TABLE customer_payments (
	id VARCHAR(32) NOT NULL, 
	customer_id VARCHAR(32) NOT NULL, 
	branch_id INTEGER NOT NULL, 
	pay_date DATE NOT NULL, 
	amount NUMERIC(14, 2) NOT NULL, 
	mode VARCHAR(16) NOT NULL, 
	note TEXT, 
	created_by_id INTEGER, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_payment_mode CHECK (mode IN ('cash','upi','bank','cheque')), 
	FOREIGN KEY(customer_id) REFERENCES customers (id) ON DELETE CASCADE, 
	FOREIGN KEY(branch_id) REFERENCES branches (id) ON DELETE CASCADE, 
	FOREIGN KEY(created_by_id) REFERENCES users (id)
);
CREATE INDEX ix_customer_payments_pay_date ON customer_payments (pay_date);
CREATE INDEX ix_customer_payments_customer_id ON customer_payments (customer_id);
CREATE INDEX ix_payment_customer_date ON customer_payments (customer_id, pay_date);

CREATE TABLE customer_sales (
	id VARCHAR(32) NOT NULL, 
	entry_id VARCHAR(32) NOT NULL, 
	customer_id VARCHAR(32) NOT NULL, 
	branch_id INTEGER NOT NULL, 
	line_no INTEGER NOT NULL, 
	product VARCHAR(16) NOT NULL, 
	weight_g INTEGER NOT NULL, 
	market_rate NUMERIC(12, 2) NOT NULL, 
	rate NUMERIC(12, 2) NOT NULL, 
	rate_override NUMERIC(12, 2), 
	amount NUMERIC(14, 2) NOT NULL, 
	settled BOOLEAN NOT NULL, 
	note TEXT, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_sale_product CHECK (product IN ('skin','skinless','liver')), 
	FOREIGN KEY(entry_id) REFERENCES daily_entries (id) ON DELETE CASCADE, 
	FOREIGN KEY(customer_id) REFERENCES customers (id) ON DELETE CASCADE, 
	FOREIGN KEY(branch_id) REFERENCES branches (id) ON DELETE CASCADE
);
CREATE INDEX ix_customer_sales_customer_id ON customer_sales (customer_id);
CREATE INDEX ix_sale_customer ON customer_sales (customer_id);
CREATE INDEX ix_sale_branch ON customer_sales (branch_id);
CREATE INDEX ix_customer_sales_entry_id ON customer_sales (entry_id);

CREATE TABLE labour_ledger (
	id VARCHAR(32) NOT NULL, 
	branch_id INTEGER NOT NULL, 
	worker_id VARCHAR(32) NOT NULL, 
	entry_date DATE NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	days NUMERIC(4, 2) NOT NULL, 
	amount NUMERIC(12, 2) NOT NULL, 
	note TEXT, 
	created_by_id INTEGER, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_ledger_kind CHECK (kind IN ('work','paid','advance','tea','tiffin','other')), 
	FOREIGN KEY(branch_id) REFERENCES branches (id) ON DELETE CASCADE, 
	FOREIGN KEY(worker_id) REFERENCES workers (id) ON DELETE CASCADE, 
	FOREIGN KEY(created_by_id) REFERENCES users (id)
);
CREATE INDEX ix_labour_ledger_branch_id ON labour_ledger (branch_id);
CREATE UNIQUE INDEX uq_ledger_work_day ON labour_ledger (worker_id, entry_date) WHERE kind = 'work';
CREATE INDEX ix_labour_ledger_worker_id ON labour_ledger (worker_id);
CREATE INDEX ix_labour_ledger_entry_date ON labour_ledger (entry_date);
CREATE INDEX ix_ledger_branch_date ON labour_ledger (branch_id, entry_date);

CREATE TABLE mortality_photos (
	id SERIAL NOT NULL, 
	entry_id VARCHAR(32) NOT NULL, 
	data_url TEXT NOT NULL, 
	uploaded_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(entry_id) REFERENCES daily_entries (id) ON DELETE CASCADE
);
CREATE INDEX ix_mortality_photos_entry_id ON mortality_photos (entry_id);

CREATE TABLE purchases (
	id SERIAL NOT NULL, 
	entry_id VARCHAR(32) NOT NULL, 
	supplier VARCHAR(160), 
	batch_no VARCHAR(64), 
	birds INTEGER NOT NULL, 
	weight_g INTEGER NOT NULL, 
	rate NUMERIC(12, 2) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(entry_id) REFERENCES daily_entries (id) ON DELETE CASCADE
);
CREATE INDEX ix_purchases_entry_id ON purchases (entry_id);

COMMIT;