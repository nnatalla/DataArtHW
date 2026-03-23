# Test Suite for ClassicChat Application

## Overview

This test suite provides comprehensive testing for the ClassicChat application backend, including database operations, API endpoints, and helper functions.

## Test Structure

```
tests/
├── db.test.ts         # Database operations tests
├── server.test.ts     # API endpoint integration tests
├── helpers.test.ts    # Helper function tests
├── tsconfig.json      # TypeScript config for tests
└── README.md          # This file
```

## Test Categories

### 1. Database Tests (`db.test.ts`)
- Database initialization and schema validation
- User operations (create, authenticate, constraints)
- Room operations (create, membership)
- Message operations (room messages, personal messages)
- Contact operations (friend requests, acceptance)
- Block operations

### 2. API Integration Tests (`server.test.ts`)
- User registration
- User login
- Protected route access
- JWT authentication
- User search
- Room creation and listing

### 3. Helper Function Tests (`helpers.test.ts`)
- Date conversion utilities
- User status logic (online/afk/offline)
- Message validation
- File upload validation
- Contact status logic
- Room visibility validation

## Running Tests

### Install Dependencies

```bash
npm install
```

### Run All Tests

```bash
npm test
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

### Run Specific Test File

```bash
npx vitest run tests/db.test.ts
npx vitest run tests/server.test.ts
npx vitest run tests/helpers.test.ts
```

## Test Configuration

Tests use a temporary SQLite database (`test_classicchat.db`) that is created and cleaned up for each test run. This ensures tests are isolated and don't interfere with each other.

Configuration is in `vitest.config.ts`:
- Test timeout: 30 seconds
- Environment: Node.js
- Coverage reporting enabled

## Adding New Tests

1. Create a new test file in the `tests/` directory
2. Use the `.test.ts` extension
3. Import necessary modules and test utilities
4. Run tests with `npm test`

## Notes

- Tests require Node.js >= 20.0.0
- A temporary test database is created in the tests directory
- Test uploads are stored in `tests/test_uploads/`
