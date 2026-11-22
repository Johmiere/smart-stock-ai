from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class RegisterRequest(BaseModel):
    first_name: str = Field(min_length=1, max_length=50)
    middle_name: str = Field(default="", max_length=50)
    suffix_name: str = Field(default="", max_length=20)
    last_name: str = Field(min_length=1, max_length=50)
    email: str = Field(min_length=3, max_length=100)
    password: str = Field(min_length=6, max_length=128)
    confirm_password: str
    barangay_id: int = Field(gt=0)
    store_option: Literal["existing", "new"]
    store_id: int | None = None
    custom_store_name: str | None = Field(default=None, max_length=50)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=100)
    password: str = Field(min_length=1, max_length=128)


class ProductPlanning(BaseModel):
    projected_price: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    unit_cost: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    season_start_month: int | None = Field(default=None, ge=1, le=12)
    season_end_month: int | None = Field(default=None, ge=1, le=12)

    @model_validator(mode="after")
    def validate_season_months(self) -> ProductPlanning:
        if (self.season_start_month is None) != (self.season_end_month is None):
            raise ValueError("Choose both season months or leave both blank for a general product.")
        return self


class ProductCreate(ProductPlanning):
    product_name: str = Field(min_length=1, max_length=100)
    product_barcode: str = Field(min_length=3, max_length=50, pattern=r"^[A-Za-z0-9_-]{3,50}$")
    product_quantity: int = Field(ge=0, le=1000000)
    category: str = Field(default="Other", max_length=40)
    unit: str = Field(default="pieces", max_length=30)
    price: float = Field(default=0, ge=0, le=99999999.99, allow_inf_nan=False)
    reorder_level: int = Field(default=0, ge=0)
    supplier_lead_time_days: int = Field(default=0, ge=0, le=365)
    safety_stock_units: int = Field(default=0, ge=0)
    expiry_date: date | None = None


class ProductMaintenance(ProductPlanning):
    price: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)

    @model_validator(mode="after")
    def validate_update(self) -> ProductMaintenance:
        fields = self.model_fields_set
        if not fields:
            raise ValueError("Enter a price, unit cost, or seasonal window.")
        if "price" in fields and self.price is None:
            raise ValueError("Enter the current selling price.")
        if ("season_start_month" in fields) != ("season_end_month" in fields):
            raise ValueError("Provide both season months to change the seasonal window.")
        return self


class StockAdjustment(BaseModel):
    action: Literal["increase", "decrease"]
    quantity: int = Field(gt=0, le=1000000)
    notes: str = Field(default="", max_length=180)
    expiry_date: date | None = None


class SaleLine(BaseModel):
    product_id: int | None = Field(default=None, gt=0)
    barcode: str | None = Field(default=None, min_length=3, max_length=50)
    quantity: int = Field(gt=0, le=10000)


SaleType = Literal["general", "seasonal"]


class CheckoutRequest(BaseModel):
    items: list[SaleLine] = Field(min_length=1, max_length=100)
    discount_type: Literal["none", "pwd", "senior"] = "none"
    discount_reference: str = Field(default="", max_length=40)
    checkout_id: UUID | None = None


class AssistantRequest(BaseModel):
    question: str = Field(min_length=2, max_length=1000)
    product_id: int | None = Field(default=None, gt=0)


class CsvImportResult(BaseModel):
    model_config = ConfigDict(extra="allow")
