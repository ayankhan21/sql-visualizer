// Pre-populated demo database: 10 related tables, every table < 50 rows.
// Deterministic on purpose so lessons always show the same data.
// Edge cases are built in on purpose:
//   * departments.6 (Legal) has no employees        -> RIGHT / FULL JOIN demos
//   * customers 19 & 20 never ordered                -> LEFT JOIN / anti-join demos
//   * products 23 & 24 never ordered                 -> LEFT JOIN / anti-join demos
//   * employees.1 has no manager (NULL)              -> self join / recursive CTE / NULL demos
//   * customers.19 has no email (NULL)               -> NULL demos
//   * shipments.delivered_date is NULL while in transit

export const MAX_ROWS = 50;
export const MAX_TABLES = 11; // 10 built-in + 1 user table

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const departments = [
  [1, 'Engineering', 'Austin', 1200000],
  [2, 'Sales', 'New York', 800000],
  [3, 'Marketing', 'Chicago', 450000],
  [4, 'Finance', 'New York', 500000],
  [5, 'HR', 'Austin', 300000],
  [6, 'Legal', 'Boston', 350000],
];

const employees = [
  [1, 'Maya Chen', 4, null, 'CEO', 250000, '2015-03-01'],
  [2, 'Liam Patel', 1, 1, 'CTO', 210000, '2016-06-15'],
  [3, 'Sofia Rossi', 2, 1, 'VP Sales', 190000, '2016-09-01'],
  [4, 'Noah Kim', 3, 1, 'VP Marketing', 175000, '2017-02-10'],
  [5, 'Emma Davis', 1, 2, 'Engineering Manager', 160000, '2018-01-20'],
  [6, 'Oliver Brown', 1, 5, 'Senior Engineer', 145000, '2018-07-11'],
  [7, 'Ava Wilson', 1, 5, 'Engineer', 120000, '2019-03-04'],
  [8, 'Lucas Garcia', 1, 5, 'Engineer', 115000, '2020-08-17'],
  [9, 'Mia Lopez', 2, 3, 'Sales Manager', 110000, '2018-11-05'],
  [10, 'Ethan Clark', 2, 9, 'Sales Rep', 72000, '2019-05-13'],
  [11, 'Isabella Hall', 2, 9, 'Sales Rep', 68000, '2020-01-27'],
  [12, 'James Young', 2, 9, 'Sales Rep', 70000, '2021-04-19'],
  [13, 'Amelia King', 3, 4, 'Marketing Manager', 98000, '2019-09-09'],
  [14, 'Henry Wright', 3, 13, 'Designer', 75000, '2021-02-01'],
  [15, 'Charlotte Scott', 4, 1, 'Finance Manager', 105000, '2017-10-23'],
  [16, 'Daniel Green', 4, 15, 'Accountant', 78000, '2020-06-30'],
  [17, 'Harper Adams', 5, 1, 'HR Manager', 92000, '2018-04-02'],
  [18, 'Jack Baker', 5, 17, 'Recruiter', 64000, '2022-01-10'],
  [19, 'Grace Nelson', 1, 5, 'Intern', 40000, '2024-06-03'],
  [20, 'Leo Carter', 2, 9, 'Sales Rep', 66000, '2023-03-15'],
];

const customerBase = [
  ['Alice Johnson', 'New York', 'USA'],
  ['Bob Smith', 'Los Angeles', 'USA'],
  ['Carla Mendes', 'Sao Paulo', 'Brazil'],
  ['David Lee', 'Seoul', 'South Korea'],
  ['Elena Fischer', 'Berlin', 'Germany'],
  ['Farid Hassan', 'Cairo', 'Egypt'],
  ['Grace Okafor', 'Lagos', 'Nigeria'],
  ['Hiro Tanaka', 'Tokyo', 'Japan'],
  ['Ines Moreau', 'Paris', 'France'],
  ['Jack Turner', 'Chicago', 'USA'],
  ['Kavya Nair', 'Mumbai', 'India'],
  ['Lars Nilsson', 'Stockholm', 'Sweden'],
  ['Mei Wong', 'Singapore', 'Singapore'],
  ['Nina Rossi', 'Rome', 'Italy'],
  ['Omar Khalid', 'Dubai', 'UAE'],
  ['Priya Sharma', 'Delhi', 'India'],
  ['Quinn Murphy', 'Dublin', 'Ireland'],
  ['Rosa Diaz', 'Madrid', 'Spain'],
  ['Sam Carter', 'Toronto', 'Canada'],
  ['Tara Brooks', 'Sydney', 'Australia'],
];
const customers = customerBase.map(([name, city, country], i) => [
  i + 1,
  name,
  i + 1 === 19 ? null : name.split(' ')[0].toLowerCase() + '@mail.com',
  city,
  country,
  addDays('2024-01-05', (i + 1) * 17),
]);

const categories = [
  [1, 'Electronics'], [2, 'Books'], [3, 'Home & Kitchen'], [4, 'Sports'], [5, 'Toys'], [6, 'Grocery'],
];

const suppliers = [
  [1, 'TechNova', 'USA'], [2, 'PageTurner Press', 'UK'], [3, 'HomeNest', 'Germany'],
  [4, 'ActiveGear', 'USA'], [5, 'FunFactory', 'China'], [6, 'FreshFields', 'Spain'],
];

const products = [
  [1, 'Wireless Mouse', 1, 1, 25.99, 150],
  [2, 'Mechanical Keyboard', 1, 1, 89.5, 80],
  [3, 'USB-C Hub', 1, 1, 39.99, 200],
  [4, 'Noise-Cancel Headphones', 1, 1, 199, 45],
  [5, 'Smart Watch', 1, 1, 249, 30],
  [6, 'SQL Basics', 2, 2, 29.95, 120],
  [7, 'Data Science Handbook', 2, 2, 54, 60],
  [8, 'The Long Road (Novel)', 2, 2, 14.5, 300],
  [9, 'Cookbook Classics', 2, 2, 32, 75],
  [10, 'Espresso Machine', 3, 3, 129, 40],
  [11, 'Air Fryer', 3, 3, 99, 55],
  [12, 'Chef Knife Set', 3, 3, 74.5, 65],
  [13, 'Cast Iron Skillet', 3, 3, 45, 90],
  [14, 'Yoga Mat', 4, 4, 22, 180],
  [15, 'Dumbbell Set', 4, 4, 85, 50],
  [16, 'Running Shoes', 4, 4, 110, 70],
  [17, 'Tennis Racket', 4, 4, 95, 35],
  [18, 'Building Blocks', 5, 5, 34.99, 140],
  [19, 'Puzzle 1000pc', 5, 5, 18.99, 160],
  [20, 'RC Car', 5, 5, 59.99, 60],
  [21, 'Olive Oil 1L', 6, 6, 12.5, 250],
  [22, 'Dark Chocolate Box', 6, 6, 9.99, 400],
  [23, 'Gourmet Coffee Beans', 6, 6, 18, 120],
  [24, 'Smart Speaker', 1, 1, 79, 0],
];

const reps = [10, 11, 12, 20];
const statuses = ['delivered', 'delivered', 'shipped', 'pending', 'cancelled'];
const orders = [];
for (let i = 1; i <= 40; i++) {
  orders.push([i, ((i * 7) % 18) + 1, reps[i % 4], addDays('2025-01-03', i * 5), statuses[i % 5]]);
}

const orderItems = [];
for (let j = 1; j <= 48; j++) {
  const pid = ((j * 7) % 22) + 1;
  orderItems.push([j, ((j * 3) % 37) + 1, pid, (j % 4) + 1, products[pid - 1][4]]);
}

const carriers = ['FedEx', 'UPS', 'DHL'];
const shipments = [];
for (const o of orders) {
  if (o[4] === 'delivered' || o[4] === 'shipped') {
    const id = shipments.length + 1;
    shipments.push([id, o[0], carriers[id % 3], addDays(o[3], 2), o[4] === 'delivered' ? addDays(o[3], 6) : null]);
  }
}

const reviews = [];
for (let k = 1; k <= 30; k++) {
  reviews.push([k, ((k * 5) % 22) + 1, ((k * 11) % 18) + 1, ((k * 3) % 5) + 1, addDays('2025-02-01', k * 6)]);
}

const c = (name, type, fk = null) => ({ name, type, fk });

export const SEED = [
  { name: 'departments', cols: [c('id', 'INT'), c('name', 'TEXT'), c('location', 'TEXT'), c('budget', 'INT')], rows: departments },
  {
    name: 'employees',
    cols: [c('id', 'INT'), c('name', 'TEXT'), c('dept_id', 'INT', 'departments.id'), c('manager_id', 'INT', 'employees.id'),
      c('title', 'TEXT'), c('salary', 'INT'), c('hire_date', 'DATE')],
    rows: employees,
  },
  { name: 'customers', cols: [c('id', 'INT'), c('name', 'TEXT'), c('email', 'TEXT'), c('city', 'TEXT'), c('country', 'TEXT'), c('signup_date', 'DATE')], rows: customers },
  { name: 'categories', cols: [c('id', 'INT'), c('name', 'TEXT')], rows: categories },
  { name: 'suppliers', cols: [c('id', 'INT'), c('name', 'TEXT'), c('country', 'TEXT')], rows: suppliers },
  {
    name: 'products',
    cols: [c('id', 'INT'), c('name', 'TEXT'), c('category_id', 'INT', 'categories.id'), c('supplier_id', 'INT', 'suppliers.id'), c('price', 'REAL'), c('stock', 'INT')],
    rows: products,
  },
  {
    name: 'orders',
    cols: [c('id', 'INT'), c('customer_id', 'INT', 'customers.id'), c('employee_id', 'INT', 'employees.id'), c('order_date', 'DATE'), c('status', 'TEXT')],
    rows: orders,
  },
  {
    name: 'order_items',
    cols: [c('id', 'INT'), c('order_id', 'INT', 'orders.id'), c('product_id', 'INT', 'products.id'), c('quantity', 'INT'), c('unit_price', 'REAL')],
    rows: orderItems,
  },
  {
    name: 'reviews',
    cols: [c('id', 'INT'), c('product_id', 'INT', 'products.id'), c('customer_id', 'INT', 'customers.id'), c('rating', 'INT'), c('review_date', 'DATE')],
    rows: reviews,
  },
  {
    name: 'shipments',
    cols: [c('id', 'INT'), c('order_id', 'INT', 'orders.id'), c('carrier', 'TEXT'), c('shipped_date', 'DATE'), c('delivered_date', 'DATE')],
    rows: shipments,
  },
];
